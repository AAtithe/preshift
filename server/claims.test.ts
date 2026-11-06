import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Claims we may not make. The Terms (legal/01-terms-of-service.md, clause 4) say the compliance
// checks are aids, not guarantees, and that Preshift Rota's labour figures are estimates until
// payroll runs. Copy that promises more contradicts the contract, and a contract term does not cure
// a misleading advert. The rule for any claim about the law: only a hard block in the engine may be
// described as "cannot"; a block a manager can override with a reason must say so; a warning is a
// warning. See section B of legal/00-legal-to-do.md for where each of these came from.
//
// This scans everything a customer, a member of staff or the AI model reads: the marketing site,
// the walkthrough captions, the app, the staff app and kiosk, server text (emails, support answers,
// the assistant's instructions), the README, docs and the published legal pages. Comments count
// too, because comments are copied into prompts, help and copy.
//
// When this fails: reword the line to say what the engine actually does, using the "instead" for
// the claim it names. Do not add an exception to make it pass.

interface Banned {
  pattern: RegExp;
  why: string;
  instead: string;
  /** A sentence the pattern must catch, so a careless edit to it cannot quietly stop it working. */
  catches: string;
  /** The approved wording, which it must not catch. */
  allows: string;
}

const BANNED: Banned[] = [
  {
    pattern: /legal by default/i,
    why: 'Promises legality; the checks support the employer, they do not replace it',
    instead: 'Checked as it is built',
    catches: 'Legal by default. Not by luck.',
    allows: 'Checked as it is built. Not after the fact.',
  },
  {
    pattern: /\b(?:cannot|can't|can not|never|unable to) roster (?:anything |anyone )?illegal/i,
    why: 'Only the hard blocks stop a shift; rest breaches can be overridden and several rules only warn',
    instead: 'every draft faces the same checks as a manager\'s',
    catches: 'So it simply can\'t roster anything illegal.',
    allows: 'Every draft faces the same checks as a manager\'s.',
  },
  {
    pattern: /\bnothing illegal\b|\bnone of it breaks the law\b|\banything that breaks the law\b/i,
    why: 'Absolute claim about the law that the engine does not and cannot make',
    instead: 'name the rule the engine checks, and whether it blocks or warns',
    catches: 'Anything that breaks the law blocks it, so nothing illegal ever reaches the team.',
    allows: 'Blocking issues stop the rota being published until they are fixed.',
  },
  {
    pattern: /\b(?:cannot|can't|can never|never|will never) break (?:the|UK) (?:employment |working time )?(?:law|regulations)\b/i,
    why: 'Absolute claim about the law',
    instead: 'cannot break the rules the engine checks',
    catches: 'The model can suggest; it cannot break the law.',
    allows: 'The model can suggest; the engine decides what is allowed.',
  },
  {
    pattern: /\bcan never break the working time\b/i,
    why: 'Absolute claim about the Working Time Regulations',
    instead: 'cannot break the rules the engine checks',
    catches: 'so a self-service change can never break the Working Time Regulations.',
    allows: 'so a self-service change cannot break the rules the engine checks.',
  },
  {
    pattern: /\bbreaks? (?:any )?UK employment law\b/i,
    why: 'The engine checks a defined list of rules, not all employment law',
    instead: 'blocks shifts that break the employment rules it checks',
    catches: 'blocks anything that breaks UK employment law',
    allows: 'blocks shifts that break the employment rules it checks',
  },
  {
    pattern: /\bthe way payroll will\b/i,
    why: 'Figures are estimates until payroll runs (Terms 4.3)',
    instead: 'on the same basis as payroll',
    catches: 'It costs every shift the way payroll will.',
    allows: 'It costs every shift on the same basis as payroll.',
  },
  {
    pattern: /\breconcile[sd]? to payroll\b/i,
    why: 'The accrual is checked against payroll, and differences are shown; it is not reconciled by construction',
    instead: 'checked against payroll every pay run',
    catches: 'fully loaded, reconciled to payroll',
    allows: 'fully loaded, checked against payroll every pay run',
  },
  {
    pattern: /\bas a regulator would\b/i,
    why: 'We are not a regulator and do not predict enforcement',
    instead: 'sized against statutory maximums',
    catches: 'Compliance risk priced as a regulator would',
    allows: 'Compliance exposure sized against statutory maximums',
  },
  {
    pattern: /\bpromise we sell\b/i,
    why: 'Frames a rule with permitted exceptions as a guarantee',
    instead: 'say what blocks and what a manager can override with a reason',
    catches: 'which is the promise we sell.',
    allows: 'unless a manager records the reason for a permitted exception.',
  },
  {
    pattern: /\bdata handled properly\b/i,
    why: 'Unsupported assurance about data protection',
    instead: 'Tools for your data protection duties, and a link to the Privacy Notice',
    catches: 'Staff data handled properly',
    allows: 'Tools for your data protection duties',
  },
  {
    pattern: /\bsuggests is legal\b|\bis legal and costed\b/i,
    why: 'Passing the checks is not the same as being lawful',
    instead: 'has passed the checks',
    catches: 'so every shift it suggests is legal and costed the way payroll will cost it.',
    allows: 'so every shift it suggests has passed the checks.',
  },
  {
    pattern: /\b(?:fully|100%|guaranteed) (?:compliant|legal)\b|\bguarantees? (?:your )?compliance\b|\balways legal\b/i,
    why: 'Guarantee of compliance the Terms disclaim',
    instead: 'name the checks',
    catches: 'Your rota is always legal and fully compliant.',
    allows: 'Your rota is checked against the Working Time Regulations as it is built.',
  },
  {
    pattern: /\bonly people trained for a role can be put on it\b/i,
    why: 'Untrained is a warning on the rota, not a block (src/engine/compliance.ts, not-trained)',
    instead: 'A warning when someone is put on a role they are not signed off for',
    catches: 'Only people trained for a role can be put on it.',
    allows: 'A warning when someone is put on a role they are not signed off for.',
  },
  {
    pattern: /\boff sick or outside the hours\b/i,
    why: 'Outside availability is a warning, not a block (src/engine/compliance.ts, availability)',
    instead: 'and a warning when a shift falls outside the hours someone said they can work',
    catches: 'No one rostered twice, on holiday, off sick or outside the hours they said they can work.',
    allows: 'No one rostered twice, on holiday or off sick, and a warning outside their availability.',
  },
];

/** Where the copy lives. */
const ROOTS = ['site', 'src', 'server', 'staff', 'kiosk', 'docs', 'legal', 'README.md', 'index.html'];
const TEXT = /\.(?:html|js|mjs|ts|tsx|md|vtt|json)$/;

/** Files that may quote a banned claim, and why. Only for records of the claims themselves. */
const NOT_COPY: Record<string, string> = {
  'legal/00-legal-to-do.md': 'The record of the claims that were withdrawn, quoting each one.',
  'server/claims.test.ts': 'This file.',
};

/**
 * Copy that still makes a banned claim and cannot be fixed in the repository. Each entry must still
 * be needed: once the claim is gone, the second test fails until the entry is deleted, so an
 * exception cannot outlive its reason.
 */
const KNOWN_EXCEPTIONS: Record<string, string> = {
  'site/video/preshift-walkthrough.vtt':
    'Captions of the recorded walkthrough narration (/walkthrough). Changing them alone would make the captions disagree with the audio. Re-record the narration with approved wording, replace the video and captions, then delete this entry.',
};

const root = path.resolve(__dirname, '..');

function copyFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) if (name !== 'node_modules') walk(path.join(rel, name));
    } else if (TEXT.test(rel) && !/\.(?:test|spec)\.tsx?$/.test(rel)) {
      out.push(rel.split(path.sep).join('/'));
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

function claimsIn(file: string): string[] {
  const found: string[] = [];
  readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const b of BANNED) {
        if (b.pattern.test(line)) found.push(`${file}:${i + 1}: "${line.trim().slice(0, 140)}"\n    Why not: ${b.why}.\n    Say instead: ${b.instead}.`);
      }
    });
  return found;
}

describe('banned marketing claims', () => {
  const files = copyFiles();

  it('scans the copy it is meant to', () => {
    for (const f of ['site/index.html', 'site/login.html', 'site/terms.html', 'site/video/preshift-walkthrough.vtt', 'README.md', 'src/ui/AssistantPanel.tsx', 'src/ai/rotaAgent.ts', 'src/engine/support.ts']) {
      expect(files).toContain(f);
    }
  });

  it('none appears in anything a customer, a member of staff or the AI reads', () => {
    const found = files.filter((f) => !(f in NOT_COPY) && !(f in KNOWN_EXCEPTIONS)).flatMap(claimsIn);
    expect(found, `Banned claims found:\n\n${found.join('\n\n')}\n`).toEqual([]);
  });

  it('every known exception still needs to be one', () => {
    for (const [file, reason] of Object.entries(KNOWN_EXCEPTIONS)) {
      expect(claimsIn(file).length, `${file} no longer makes a banned claim. Delete its entry in KNOWN_EXCEPTIONS (${reason})`).toBeGreaterThan(0);
    }
  });

  it('each rule catches its claim and allows the approved wording', () => {
    for (const b of BANNED) {
      expect(b.pattern.test(b.catches), `${b.pattern} should catch: ${b.catches}`).toBe(true);
      expect(b.pattern.test(b.allows), `${b.pattern} should allow: ${b.allows}`).toBe(false);
    }
  });
});
