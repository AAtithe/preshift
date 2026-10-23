import type { Employee } from './types';

export const PIN_LENGTH = { min: 4, max: 6 };

/**
 * Why a kiosk PIN would be too easy to guess, or null. Colleagues stand next to each other at the
 * kiosk and often know each other's birthdays, so a PIN made from the person's own date of birth is
 * refused along with repeats and runs.
 */
export function pinProblem(pin: unknown, employee: Pick<Employee, 'dateOfBirth'>): string | null {
  if (typeof pin !== 'string' || !/^\d+$/.test(pin) || pin.length < PIN_LENGTH.min || pin.length > PIN_LENGTH.max) {
    return `Use ${PIN_LENGTH.min} to ${PIN_LENGTH.max} digits.`;
  }
  if (/^(\d)\1+$/.test(pin)) return 'Do not repeat one digit.';
  const digits = [...pin].map(Number);
  const run = (step: number) => digits.every((d, i) => i === 0 || d === (digits[i - 1] + step + 10) % 10);
  if (run(1) || run(-1)) return 'Do not use a run of digits like 1234.';
  if (birthForms(employee.dateOfBirth).includes(pin)) return 'Do not use your date of birth.';
  return null;
}

function birthForms(dob: string | undefined): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob ?? '');
  if (!m) return [];
  const [, yyyy, mm, dd] = m;
  const yy = yyyy.slice(2);
  return [`${dd}${mm}`, `${mm}${dd}`, yyyy, `${dd}${mm}${yy}`, `${mm}${dd}${yy}`, `${yy}${mm}${dd}`];
}

/** A random PIN that passes pinProblem, for a manager to hand over. */
export function randomPin(employee: Pick<Employee, 'dateOfBirth'>, random: () => number = Math.random): string {
  for (;;) {
    const pin = String(Math.floor(random() * 10_000)).padStart(4, '0');
    if (!pinProblem(pin, employee)) return pin;
  }
}
