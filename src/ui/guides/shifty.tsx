// The guide to Shifty.

export const shiftyGuide = {
  id: 'shifty',
  title: 'Ask Shifty',
  summary: 'Ask questions in plain English, or tell Preshift what to do, and confirm each change before it happens.',
  Body: ShiftyGuide,
};

function ShiftyGuide() {
  return (
    <>
      <h3>One place to ask</h3>
      <p>
        <strong>Ask Shifty</strong>, in the bottom right, takes questions and conversation ("Are we on target this week?",
        "Who is working Saturday night?", "How much holiday has Grace got left?") and things to get done in one line
        ("Please add a new starter, Sam Lee, bartender at Marylebone from Monday on £12.71"). Press Ctrl K (Cmd K on a Mac)
        to open it from anywhere.
      </p>

      <h3>Nothing changes until you confirm</h3>
      <ol className="guide-steps">
        <li><strong>Read the card.</strong> Every change, such as a starter, a leaver, holiday, an absence or a shift, comes back as a card with the details.</li>
        <li><strong>Confirm, or cancel.</strong> Confirm saves it through the same checks as the screens. For a starter, Review in People opens the full record to finish it there.</li>
        <li><strong>If something is missing,</strong> it asks. A starter needs a name, site, role, start date, date of birth and pay.</li>
      </ol>

      <h3>What it can do</h3>
      <ul>
        <li>Look up people, shifts, labour % and cost, compliance issues and holiday balances.</li>
        <li>Set up a starter, change pay, hours, roles, cover sites or rota notes, mark a leaver, book holiday, record an absence, add or remove a shift, and publish a week.</li>
        <li>Hand a bigger job, such as building the week, to the rota assistant.</li>
        <li>Open any screen for you.</li>
      </ul>

      <h3>What it will not do</h3>
      <ul>
        <li>Break employment law: pay below the minimum wage for someone's age, young worker limits, rostering on leave or sickness.</li>
        <li>Change anything without your confirmation.</li>
        <li>Ask for or repeat NI numbers, addresses, bank details or medical information. New starters are set up without a right to work check, so record one in People before rostering them.</li>
      </ul>

      <h3>Cost</h3>
      <p>Shifty shows what each chat has cost in Claude usage, usually a few cents. It counts towards the same spending limits as the rota assistant, set under Settings.</p>
    </>
  );
}
