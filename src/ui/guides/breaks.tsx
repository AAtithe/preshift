// The breaks guide for GMs. The steps are shared with the Payroll pop-ups, so the screen and the
// How to always say the same thing.

/** What to do with each flagged shift, in order. Used in the guide and in both pop-ups. */
export function BreakSteps() {
  return (
    <ol className="guide-steps">
      <li>
        <strong>Find out what happened.</strong> Ask the person, or the manager who ran that shift. Do it this week, while
        people remember.
      </li>
      <li>
        <strong>Break taken but not recorded:</strong> enter the minutes they actually took and press Save. The shift goes
        back to waiting for approval.
      </li>
      <li>
        <strong>Break not taken:</strong> leave the record as it is. Never enter a break that did not happen. It would cut
        their pay for time they worked and leave us with a false record.
      </li>
      <li>
        <strong>Approve.</strong> Approval is never blocked. The system records that you approved with these shifts flagged,
        so the record shows they were seen.
      </li>
      <li>
        <strong>Under 18s:</strong> treat every flag as serious. Speak to the manager on that shift and make sure the next
        rota gives them their break.
      </li>
    </ol>
  );
}

/** The rule in two lines, for the top of the pop-ups. */
export function BreakRule() {
  return (
    <p>
      The law gives every adult who works more than 6 hours a <strong>20 minute</strong> rest break, taken in one go. Under 18s
      get <strong>30 minutes</strong> once they work more than 4.5 hours. Breaks are unpaid, so the break on the record changes
      what someone is paid.
    </p>
  );
}

export const breaksGuide = {
  id: 'breaks',
  title: 'Breaks below the legal minimum',
  summary: 'What the break flag on the Payroll tab means, and what to do before you approve hours.',
  Body: BreaksGuide,
};

function BreaksGuide() {
  return (
    <>
      <h3>Why it matters</h3>
      <BreakRule />
      <p>
        Getting breaks right does three things. It protects the person: they are paid for every minute they worked and get the
        rest they are owed. It protects us: our time records are evidence if a break is ever disputed, at a tribunal or in an
        inspection. And it tells us whether the rota is really staffed for the shift, because missed breaks are usually a sign
        the floor was short.
      </p>

      <h3>What the flag means</h3>
      <p>Before you approve, the Payroll tab lists any finished shift this week with less break than the law gives.</p>
      <ul>
        <li>
          <strong>No break, or short:</strong> less break in total than the minimum. For example, 10 minutes on an 8 hour
          shift.
        </li>
        <li>
          <strong>Split:</strong> enough minutes in total, but taken in pieces, so no single break was long enough. For
          example, two 10 minute breaks. The law wants one 20 minute block.
        </li>
        <li>
          <strong>Under 18:</strong> the person was under 18 on the day, so the 30 minute rule applies.
        </li>
      </ul>
      <p className="muted small">
        Hours worked leave out the break itself. Someone on site for 6 hours 10 minutes with a 20 minute break has worked 5
        hours 50, and is not flagged.
      </p>

      <h3>What to do, every week before you approve</h3>
      <p>Open Payroll for your site. The flags sit under Manager approval. Then, for each flagged shift:</p>
      <BreakSteps />

      <h3>Fix the cause, not just the record</h3>
      <p>
        Look for the pattern, not the single shift. The same nights, the same people, the same site. If breaks are missed every
        Friday and Saturday, the rota is short on peak nights, and the fix is on the rota, not in payroll. Make sure every
        shift on the rota plans at least the legal minimum break, and that the shift lead knows who goes when.
      </p>

      <h3>Staff can record breaks themselves</h3>
      <p>
        Staff with a phone login press Start break and End break in the staff app. Anyone tapping their card during a break is
        taken as coming back, not leaving, so their shift carries on. The more your team records breaks as they take them, the
        fewer corrections you make on Monday.
      </p>

      <h3>Common questions</h3>
      <dl className="guide-faq">
        <dt>They told me they did not want a break.</dt>
        <dd>
          We must give everyone a real chance to take it, and service pressure is not a real chance. An adult can choose not to
          take it, but it must be their choice. Under 18s should always take theirs. Talk to the person and note it.
        </dd>
        <dt>Can I pay them for the break instead?</dt>
        <dd>No. A rest break cannot be swapped for pay.</dd>
        <dt>They took two 10 minute breaks.</dt>
        <dd>That shows as split. It is not a pay problem, but plan one 20 minute break on the rota for that shift.</dd>
        <dt>The flag is wrong.</dt>
        <dd>
          Check the clock times first: a late clock-out makes the shift longer than it was. If the times or the break are
          wrong, correct them on the entry. If the record is right, the flag is right.
        </dd>
      </dl>
    </>
  );
}
