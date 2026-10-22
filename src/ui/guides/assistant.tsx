// The rota assistant guide for GMs: how to ask, what it will and will not do, and how to check a draft.

export const assistantGuide = {
  id: 'assistant',
  title: 'Drafting the rota with the assistant',
  summary: 'How to ask for a rota in plain English, what the assistant will never do, and how to check its draft before you apply it.',
  Body: AssistantGuide,
};

function AssistantGuide() {
  return (
    <>
      <h3>What it is for</h3>
      <p>
        The assistant drafts the week for you from a plain English request, for one site or for every site in view. It uses the
        same costing and the same employment law checks as the rota itself, so every shift it suggests is legal and costed the
        way payroll will cost it. Nothing changes until you press <strong>Apply draft</strong>.
      </p>

      <h3>How to ask</h3>
      <ol className="guide-steps">
        <li>
          <strong>Choose the week and the sites</strong> at the top, then press <strong>Ask the assistant</strong>. Choose all
          sites, or a company, to plan them together and share staff between them.
        </li>
        <li>
          <strong>Say what you need, as you would to a deputy.</strong> For example: "Ben is off Saturday, re-cover the bar
          without going over target", or "We have a private party on Friday from 7pm, add two servers".
        </li>
        <li>
          <strong>Read the draft.</strong> Check each site's labour % against its target, the changes, any cover borrowed from
          another company (that is an intercompany recharge), and the note underneath.
        </li>
        <li>
          <strong>Ask for changes to the same draft</strong> in the box under it, such as "give Sofia Sunday off". It keeps
          everything else.
        </li>
        <li>
          <strong>Apply, then publish as normal.</strong> If someone else changed the week while you were drafting, the save is
          refused so their work is not lost: start again from the current rota.
        </li>
      </ol>

      <h3>What it will never do</h3>
      <ul>
        <li>Roster anyone illegally: on leave or off sick, under 18 beyond their limits, without a right to work check, or before they start or after they leave.</li>
        <li>Move or remove a shift that has started or that someone has clocked against. What happened stays as it happened.</li>
        <li>Borrow someone from another site who has not agreed to cover it. Add their cover sites on their record in People.</li>
        <li>Book holiday. It will suggest who could be offered a quiet shift as leave, and you decide.</li>
      </ul>

      <h3>Getting a fairer rota</h3>
      <p>
        The assistant looks at the last four weeks: who has had the weekends and the closes, and who has been late or missed
        shifts, so it shares the hard shifts out and does not leave a quiet shift to someone it cannot rely on. It also reads
        each person's <strong>Rota notes</strong> on their record in People. Write down what the rota should respect there, such
        as "college on Tuesdays until June", and it will plan round it.
      </p>

      <h3>What it costs</h3>
      <p>
        Each draft shows what it cost in Claude usage, typically a few tens of cents. An admin sets a monthly limit for the
        organisation and a daily limit per person under Settings; when a limit is reached the assistant says so and stops until
        it resets or is raised.
      </p>
    </>
  );
}
