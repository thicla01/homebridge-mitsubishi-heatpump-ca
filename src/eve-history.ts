/**
 * Native implementation of the Eve (Elgato) history protocol, so the Eve app can
 * draw long-term room-temperature graphs for each unit.
 *
 * Why native: the de-facto library, fakegato-history, is 104KB of code with a HARD
 * dependency on `googleapis` — 204MB on disk — for an optional Google Drive backup
 * this plugin would never use. On the Raspberry Pi installs this plugin targets,
 * that is 204MB re-written to the SD card on every plugin update. The protocol
 * itself is small: four custom DATA characteristics on one custom service, and a
 * circular buffer of 16-byte records.
 *
 * The wire format below was extracted from fakegato-history 0.6.7 (the reference
 * implementation, byte-for-byte), cross-checked against simont77's protocol gist
 * and ebaauw's independent homebridge-lib reimplementation, and pinned by golden
 * vectors captured from fakegato itself driven with a frozen clock — see
 * test/eve-history.test.ts. Several behaviours look like off-by-one bugs (the
 * status "count" field is usedMemory+1 while the buffer fills; the first sample
 * writes TWO slots). They are the known-good wire behaviour Eve has accepted for a
 * decade: replicate, don't rationalize.
 *
 * We use the canonical "Eve Weather" fingerprint (temperature / humidity /
 * pressure, signature 03 0102 0202 0302) with the fixed 0x07 bitmask and zeros for
 * fields we don't have, rather than the protocol-legal per-entry variable bitmask.
 * Eve 3.8.1 briefly rejected accessories whose shape it didn't recognise
 * (fakegato-history#76); the fixed weather shape is the most battle-tested, and a
 * zeroed pressure sub-graph costs nothing while temperature — the point of the
 * feature — always renders.
 */

import fs from 'fs';
import path from 'path';
import type { API, Logger, PlatformAccessory, Service as HBService } from 'homebridge';

type HAP = API['hap'];

/** Seconds between the Unix epoch and the Eve epoch (2001-01-01T00:00:00Z). */
const EVE_EPOCH_OFFSET = 978307200;

/** Entries the circular buffer holds: 4032 = four weeks at one per 10 minutes. */
export const EVE_MEMORY_SIZE = 4032;

/** How many records one S2R2 read returns. fakegato's pacing; Eve just keeps reading. */
const RECORDS_PER_READ = 11;

export const EVE_HISTORY_SERVICE_UUID = 'E863F007-079E-48FF-8F27-9C2605A29F52';
const S2R1_UUID = 'E863F116-079E-48FF-8F27-9C2605A29F52'; // History Status (read+notify)
const S2R2_UUID = 'E863F117-079E-48FF-8F27-9C2605A29F52'; // History Entries (read)
const S2W1_UUID = 'E863F11C-079E-48FF-8F27-9C2605A29F52'; // History Request (write)
const S2W2_UUID = 'E863F121-079E-48FF-8F27-9C2605A29F52'; // Set Time (write, ignored)

/** One slot of the circular buffer. `ref: 1` marks a reference-time record. */
interface Slot {
  /** Unix seconds of the sample (or of the moment the marker was written). */
  t: number;
  temp?: number;
  hum?: number;
  ref?: 1;
}

/** What survives a restart. Everything else is per-session and rebuilt cold. */
interface PersistShape {
  v: 1;
  memorySize: number;
  /** Unix seconds of the very first sample; refTime on the wire is this minus the Eve epoch. */
  initialTime: number;
  firstEntry: number;
  lastEntry: number;
  usedMemory: number;
  /** Live slots as [counter, slot] pairs — sparse, order irrelevant. */
  entries: Array<[number, Slot]>;
}

// ---------------------------------------------------------------------------
// The store: circular buffer + wire encoding + persistence.
// Pure protocol — no hap, no timers — so the golden-vector tests can drive it
// from dist/ without a Homebridge in sight.
// ---------------------------------------------------------------------------

export class EveHistoryStore {
  private readonly memorySize: number;
  private readonly log?: Logger;
  private readonly filePath?: string;
  private readonly now: () => number;

  /** Unix seconds of the first sample ever; 0 until one exists. */
  private initialTime = 0;
  /**
   * Absolute entry counters, 1-based, growing forever — they are the addresses
   * Eve requests, so they NEVER reset or shrink (fakegato's comment says "in
   * order to be consistent" and the read session depends on it). `firstEntry` is
   * oldest-1 while filling and slides once full; `lastEntry` is the newest.
   */
  private firstEntry = 0;
  private lastEntry = 0;
  /** Live slots, markers included; ≤ memorySize. */
  private usedMemory = 0;
  private slots: Array<Slot | undefined>;

  /**
   * True from construction until the first add into a FULL buffer, which then
   * writes an extra reference-time marker (evicting two entries in one add) so a
   * long-running Eve can re-anchor after our restart. Note this also fires on the
   * first-ever wraparound of a process that never restarted — harmless, and
   * exactly what the reference implementation does.
   */
  private restarted = true;
  /**
   * True from construction until the first record of the first transfer, which is
   * then sent as a reference-time record in place of the data at that position.
   * The sacrificed data point is the protocol's restart-resync cost; Eve
   * tolerates it.
   */
  private setTimeFlag = true;

  private transfer = false;
  private cursor = 0;

  /** Fired with the fresh S2R1 base64 after every committed entry (drives NOTIFY). */
  onStatusUpdate?: (base64: string) => void;

  constructor(opts: { filePath?: string; log?: Logger; memorySize?: number; now?: () => number } = {}) {
    this.memorySize = opts.memorySize ?? EVE_MEMORY_SIZE;
    this.filePath = opts.filePath;
    this.log = opts.log;
    this.now = opts.now ?? (() => Math.round(Date.now() / 1000));
    this.slots = new Array<Slot | undefined>(this.memorySize);
  }

  /** Number of live entries (markers included). Exposed for tests and logging. */
  get size(): number {
    return this.usedMemory;
  }

  // -- writing --------------------------------------------------------------

  /**
   * Commit one averaged sample. `t` is Unix seconds.
   *
   * A non-monotonic timestamp is skipped rather than written: entry times go on
   * the wire as unsigned deltas since the first sample, so a clock step backwards
   * would wrap to ~136 years in the future — and Eve refuses to display entries
   * with future timestamps, silently (ebaauw). A Pi booting before NTP sync is
   * the realistic way this happens.
   */
  addEntry(sample: { t: number; temp: number; hum?: number }): void {
    const last = this.lastSlot();
    if (last && sample.t <= last.t) {
      this.log?.debug(
        `[EVE] non-monotonic sample time ${sample.t} (last ${last.t}) — skipped`,
      );
      return;
    }

    if (this.initialTime === 0) {
      // The first sample writes TWO slots: a reference-time marker at counter 1,
      // then the data at counter 2. This is why the very first S2R1 already
      // reports a count of 3 (usedMemory 2, +1 while filling).
      this.initialTime = sample.t;
      this.writeSlot(1, { t: sample.t, ref: 1 });
      this.lastEntry = 1;
      this.usedMemory = 1;
    } else if (this.usedMemory === this.memorySize && this.restarted) {
      // First add into a full buffer since construction: insert a marker so Eve
      // re-anchors, advancing everything one extra step (two evictions, one add).
      this.restarted = false;
      this.lastEntry += 1;
      this.firstEntry += 1;
      this.writeSlot(this.lastEntry, { t: sample.t, ref: 1 });
    }

    this.lastEntry += 1;
    this.writeSlot(this.lastEntry, { t: sample.t, temp: sample.temp, hum: sample.hum });
    if (this.usedMemory < this.memorySize) {
      this.usedMemory += 1;
    } else {
      this.firstEntry += 1;
    }

    this.save();
    if (this.onStatusUpdate) {
      this.onStatusUpdate(this.statusBase64());
    }
  }

  private writeSlot(counter: number, slot: Slot): void {
    this.slots[counter % this.memorySize] = slot;
  }

  private lastSlot(): Slot | undefined {
    return this.lastEntry === 0 ? undefined : this.slots[this.lastEntry % this.memorySize];
  }

  // -- the wire: S2R1 -------------------------------------------------------

  /**
   * The 33-byte History Status blob, or '' when no entry exists yet — the
   * reference implementation serves nothing before the first sample, and a
   * decade of Eve versions accepts that, so an invented empty-state blob would
   * be the riskier choice.
   */
  statusBase64(): string {
    const last = this.lastSlot();
    if (!last) {
      return '';
    }
    const full = this.usedMemory === this.memorySize;
    const b = Buffer.alloc(33);
    b.writeUInt32LE(last.t - this.initialTime, 0); // newest entry, seconds since refTime
    // bytes 4-7 stay zero
    b.writeUInt32LE(this.initialTime - EVE_EPOCH_OFFSET, 8); // refTime, Eve epoch
    // The Eve Weather 2015 signature: three (type, length) pairs — temperature,
    // humidity, pressure, 2 bytes each. Eve derives the graph set from this.
    Buffer.from('03010202020302', 'hex').copy(b, 12);
    // The count field is usedMemory+1 while filling, usedMemory once full; the
    // oldest-counter field is firstEntry while filling, firstEntry+1 once full.
    // Asymmetric on purpose — this is the observed wire behaviour (golden
    // vectors), not arithmetic to "fix".
    b.writeUInt16LE(full ? this.usedMemory : this.usedMemory + 1, 19);
    b.writeUInt16LE(this.memorySize, 21);
    b.writeUInt32LE(full ? this.firstEntry + 1 : this.firstEntry, 23);
    // bytes 27-30 stay zero
    b[31] = 0x01;
    b[32] = 0x01;
    return b.toString('base64');
  }

  // -- the wire: S2W1 / S2R2 ------------------------------------------------

  /**
   * Eve wrote a history request: bytes 2..5 are the starting absolute counter,
   * little-endian; every other byte is padding and ignored (as the reference
   * implementation does). Address 0 means "from the beginning".
   */
  startTransfer(requestBase64: string): void {
    const req = Buffer.from(String(requestBase64), 'base64');
    const address = req.length >= 6 ? req.readUInt32LE(2) : 0;
    this.cursor = address === 0 ? 1 : address;
    this.transfer = true;
  }

  /**
   * One S2R2 read: up to RECORDS_PER_READ records, concatenated; the single byte
   * 0x00 when the transfer is exhausted (and on every idle read).
   */
  readChunkBase64(): string {
    if (!this.transfer || this.lastEntry === 0 || this.cursor > this.lastEntry) {
      this.transfer = false;
      return Buffer.from([0x00]).toString('base64');
    }
    const records: Buffer[] = [];
    for (let i = 0; i < RECORDS_PER_READ && this.cursor <= this.lastEntry; i++) {
      records.push(this.recordAt(this.cursor));
      this.cursor += 1;
    }
    return Buffer.concat(records).toString('base64');
  }

  private recordAt(counter: number): Buffer {
    const slot = this.slots[counter % this.memorySize];
    // A position carries a reference-time record instead of its data when it is a
    // stored marker, when this is the first record since our restart, or when it
    // is the oldest retrievable position after rollover. In each case the data
    // that lived there is sacrificed — Eve tolerates the lost point, and the
    // record always carries the ORIGINAL refTime, never the marker's own time.
    if (!slot || slot.ref === 1 || this.setTimeFlag || counter === this.firstEntry + 1) {
      this.setTimeFlag = false;
      const b = Buffer.alloc(21);
      b[0] = 0x15;
      b.writeUInt32LE(counter, 1);
      b.writeUInt32LE(1, 5);
      b[9] = 0x81;
      b.writeUInt32LE(this.initialTime - EVE_EPOCH_OFFSET, 10);
      return b;
    }
    const b = Buffer.alloc(16);
    b[0] = 0x10;
    b.writeUInt32LE(counter, 1);
    b.writeUInt32LE(slot.t - this.initialTime, 5);
    b[9] = 0x07; // temp + humidity + pressure all "present"; absent ones read 0
    // Math.round, deliberately NOT the reference implementation's bitwise
    // truncation: 21.3 * 100 is 2129.999… in IEEE754, which fakegato serves as
    // 21.29°C. The golden-vector test pins this one divergence by name.
    b.writeInt16LE(Math.round(slot.temp! * 100), 10);
    b.writeUInt16LE(Math.round((slot.hum ?? 0) * 100), 12);
    b.writeUInt16LE(0, 14); // pressure: never logged
    return b;
  }

  // -- persistence ----------------------------------------------------------

  /**
   * Written on every commit — once per averaging interval, ~10 minutes — with a
   * write-to-temp-then-rename so a power cut mid-write (SD card on a Pi) leaves
   * the previous file intact instead of truncated JSON. The reference
   * implementation writes in place and keys the file by accessory DISPLAY NAME,
   * so renaming a unit orphans its history; ours is keyed by device serial.
   */
  private save(): void {
    if (!this.filePath) {
      return;
    }
    try {
      const entries: Array<[number, Slot]> = [];
      const from = Math.max(1, this.firstEntry);
      for (let c = from; c <= this.lastEntry; c++) {
        const slot = this.slots[c % this.memorySize];
        if (slot) {
          entries.push([c, slot]);
        }
      }
      const shape: PersistShape = {
        v: 1,
        memorySize: this.memorySize,
        initialTime: this.initialTime,
        firstEntry: this.firstEntry,
        lastEntry: this.lastEntry,
        usedMemory: this.usedMemory,
        entries,
      };
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(shape));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      // History must never take the bridge down; a failed save costs one interval.
      this.log?.warn(`[EVE] could not persist history: ${(e as Error).message}`);
    }
  }

  /**
   * Load persisted history. Any defect — unreadable file, bad JSON, another
   * memory size, a first-sample time in the future ("after time travel",
   * ebaauw's phrase: a Pi that booted with a wrong clock and wrote entries ahead
   * of real time) — resets to empty with one warning rather than throwing:
   * nothing above the accessory constructor catches, and stale graphs are not
   * worth a bridge that will not start.
   */
  load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const shape = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PersistShape;
      if (shape.v !== 1 || shape.memorySize !== this.memorySize) {
        this.log?.warn('[EVE] history file has an unknown shape — starting fresh');
        return;
      }
      if (shape.initialTime > this.now()) {
        this.log?.warn('[EVE] history starts in the future (clock moved back) — starting fresh');
        return;
      }
      this.initialTime = shape.initialTime;
      this.firstEntry = shape.firstEntry;
      this.lastEntry = shape.lastEntry;
      this.usedMemory = shape.usedMemory;
      for (const [c, slot] of shape.entries) {
        this.writeSlot(c, slot);
      }
    } catch (e) {
      this.log?.warn(`[EVE] could not read history file — starting fresh: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The feed: turns the 15-second status stream into one committed entry per
// interval, the cadence Eve expects.
// ---------------------------------------------------------------------------

export class EveHistoryFeed {
  private tempSum = 0;
  private tempCount = 0;
  private humSum = 0;
  private humCount = 0;
  /** Last humidity actually observed, carried into intervals where none arrived. */
  private lastHum: number | undefined;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: EveHistoryStore,
    private readonly intervalMs = 10 * 60 * 1000,
    private readonly now: () => number = () => Math.round(Date.now() / 1000),
  ) {}

  /** Called on every status commit, whatever the transport. Nulls are ignored. */
  pushSample(temp: number | null | undefined, hum: number | null | undefined): void {
    if (typeof temp === 'number' && Number.isFinite(temp)) {
      this.tempSum += temp;
      this.tempCount += 1;
    }
    if (typeof hum === 'number' && Number.isFinite(hum)) {
      this.humSum += hum;
      this.humCount += 1;
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Never keep the process alive for a graph: Homebridge's shutdown, and the
    // test runner's exit, must not wait on this.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Commit the interval's average. An interval with NO temperature sample
   * commits nothing — an honest gap in the graph. The reference implementation
   * defaults to repeating the last value forever, which draws a flat line
   * through an outage; on a plugin whose LAN transport can drop for minutes
   * (observed live: up to 16 consecutive failed polls), a flat line is a lie
   * about the one thing the graph exists to show.
   */
  tick(): void {
    if (this.tempCount === 0) {
      return;
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const hum = this.humCount > 0 ? round2(this.humSum / this.humCount) : this.lastHum;
    if (this.humCount > 0) {
      this.lastHum = hum;
    }
    this.store.addEntry({ t: this.now(), temp: round2(this.tempSum / this.tempCount), hum });
    this.tempSum = this.tempCount = this.humSum = this.humCount = 0;
  }
}

// ---------------------------------------------------------------------------
// hap wiring: the custom service and characteristics, built against the
// Homebridge-supplied hap instance (never a static hap-nodejs import — the
// plugin must drive the bridge's own instance).
// ---------------------------------------------------------------------------

interface EveTypes {
  HistoryService: new (displayName: string, subtype?: string) => HBService;
  S2R1: { UUID: string };
  S2R2: { UUID: string };
  S2W1: { UUID: string };
  S2W2: { UUID: string };
}

const typesByHap = new WeakMap<object, EveTypes>();

function buildEveTypes(hap: HAP): EveTypes {
  const cached = typesByHap.get(hap);
  if (cached) {
    return cached;
  }
  const { Characteristic, Service, Formats, Perms } = hap;

  class S2R1 extends Characteristic {
    static readonly UUID = S2R1_UUID;
    constructor() {
      super('History Status', S2R1_UUID, {
        format: Formats.DATA,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY, Perms.HIDDEN],
      });
    }
  }
  class S2R2 extends Characteristic {
    static readonly UUID = S2R2_UUID;
    constructor() {
      super('History Entries', S2R2_UUID, {
        format: Formats.DATA,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY, Perms.HIDDEN],
      });
    }
  }
  class S2W1 extends Characteristic {
    static readonly UUID = S2W1_UUID;
    constructor() {
      super('History Request', S2W1_UUID, {
        format: Formats.DATA,
        perms: [Perms.PAIRED_WRITE, Perms.HIDDEN],
      });
    }
  }
  class S2W2 extends Characteristic {
    static readonly UUID = S2W2_UUID;
    constructor() {
      super('Set Time', S2W2_UUID, {
        format: Formats.DATA,
        perms: [Perms.PAIRED_WRITE, Perms.HIDDEN],
      });
    }
  }
  class HistoryService extends Service {
    static readonly UUID = EVE_HISTORY_SERVICE_UUID;
    constructor(displayName: string, subtype?: string) {
      super(displayName, EVE_HISTORY_SERVICE_UUID, subtype);
      this.addCharacteristic(new S2R1());
      this.addCharacteristic(new S2R2());
      this.addCharacteristic(new S2W1());
      this.addCharacteristic(new S2W2());
    }
  }

  const types: EveTypes = { HistoryService, S2R1, S2R2, S2W1, S2W2 };
  typesByHap.set(hap, types);
  return types;
}

/**
 * Add (or re-adopt from the accessory cache) the history service and wire its
 * handlers to the store. Returns the service for tests.
 *
 * S2W2 (Eve pushing its wall clock) is accepted and discarded: the write must
 * succeed or Eve stalls the session, but every implementation surveyed ignores
 * the payload — our entries are stamped with the host's own clock.
 */
export function attachEveHistory(
  hap: HAP,
  accessory: PlatformAccessory,
  store: EveHistoryStore,
): HBService {
  const types = buildEveTypes(hap);

  let service = accessory.services.find((s) => s.UUID === EVE_HISTORY_SERVICE_UUID);
  if (!service) {
    service = accessory.addService(
      new types.HistoryService(`${accessory.displayName} History`, 'kumo-eve-history'),
    );
  }
  // A service restored from cachedAccessories comes back as a generic Service
  // that already carries the four characteristics; getCharacteristic by class
  // finds them by UUID either way.
  const s2r1 = service.getCharacteristic(types.S2R1 as never);
  const s2r2 = service.getCharacteristic(types.S2R2 as never);
  const s2w1 = service.getCharacteristic(types.S2W1 as never);
  const s2w2 = service.getCharacteristic(types.S2W2 as never);

  s2r1.onGet(() => store.statusBase64());
  s2r2.onGet(() => store.readChunkBase64());
  s2w1.onSet((value) => store.startTransfer(String(value)));
  s2w2.onSet(() => { /* accepted, ignored — see the function comment */ });

  store.onStatusUpdate = (base64) => s2r1.updateValue(base64);

  return service;
}
