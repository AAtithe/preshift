import { randomInt } from 'node:crypto';
import { pinProblem, randomPin } from '../src/engine/pin';
import type { Employee } from '../src/engine/types';
import { HttpError } from './context';
import { hashPassword, verifyPassword } from './passwords';
import type { Store } from './store';

// Kiosk PINs. The hash lives in the settings store, apart from organisation data, so no data
// endpoint can return it; the employee record only says when it was set and by whom. A PIN is
// short, so what protects it is the lockout: five wrong tries lock that person's PIN for 15 minutes.

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

interface PinRecord {
  salt: string;
  hash: string;
  failed: number;
  /** Epoch milliseconds. */
  lockedUntil: number;
}

const key = (orgId: string, employeeId: string) => `kiosk_pin:${orgId}:${employeeId}`;

async function read(store: Store, orgId: string, employeeId: string): Promise<PinRecord | null> {
  const raw = await store.getSetting(key(orgId, employeeId));
  return raw ? (JSON.parse(raw) as PinRecord) : null;
}

const write = (store: Store, orgId: string, employeeId: string, rec: PinRecord) => store.setSetting(key(orgId, employeeId), JSON.stringify(rec));

/** Sets the PIN after checking it is not too easy to guess. Clears any lockout. */
export async function setPin(store: Store, orgId: string, employee: Employee, pin: string, by: 'self' | 'manager'): Promise<void> {
  const problem = pinProblem(pin, employee);
  if (problem) throw new HttpError(422, 'weak_pin', problem);
  await write(store, orgId, employee.id, { ...(await hashPassword(pin)), failed: 0, lockedUntil: 0 });
  employee.kioskPinSetAt = new Date().toISOString();
  employee.kioskPinSetBy = by;
}

/** A new random PIN for a manager to hand over. Returned once and never stored in the clear. */
export async function issuePin(store: Store, orgId: string, employee: Employee): Promise<string> {
  const pin = randomPin(employee, () => randomInt(0, 10_000) / 10_000);
  await setPin(store, orgId, employee, pin, 'manager');
  return pin;
}

export async function clearPin(store: Store, orgId: string, employee: Employee): Promise<void> {
  await store.setSetting(key(orgId, employee.id), null);
  delete employee.kioskPinSetAt;
  delete employee.kioskPinSetBy;
}

export async function pinLocked(store: Store, orgId: string, employeeId: string): Promise<boolean> {
  return ((await read(store, orgId, employeeId))?.lockedUntil ?? 0) > Date.now();
}

/** Refuses unless the PIN is right, counting wrong tries towards the lockout. */
export async function checkPin(store: Store, orgId: string, employee: Employee, pin: string | undefined): Promise<void> {
  const first = employee.name.split(' ')[0];
  const rec = await read(store, orgId, employee.id);
  if (!rec) throw new HttpError(403, 'no_pin', `${first}, you need a PIN to sign in by name here. Set one in the staff app, ask a manager, or use your card.`);
  if (rec.lockedUntil > Date.now()) {
    throw new HttpError(429, 'pin_locked', `Too many wrong PINs, ${first}. Use your card, or try again in 15 minutes.`);
  }
  if (!pin) throw new HttpError(401, 'pin_required', 'Enter your PIN.');
  if (await verifyPassword(rec, pin)) {
    if (rec.failed) await write(store, orgId, employee.id, { ...rec, failed: 0, lockedUntil: 0 });
    return;
  }
  const failed = rec.failed + 1;
  const lock = failed >= MAX_FAILURES;
  await write(store, orgId, employee.id, { ...rec, failed: lock ? 0 : failed, lockedUntil: lock ? Date.now() + LOCK_MS : 0 });
  if (lock) throw new HttpError(429, 'pin_locked', `Too many wrong PINs, ${first}. Use your card, or try again in 15 minutes.`);
  throw new HttpError(401, 'wrong_pin', `That PIN is not right. ${MAX_FAILURES - failed} ${MAX_FAILURES - failed === 1 ? 'try' : 'tries'} left.`, { triesLeft: MAX_FAILURES - failed });
}
