// Deciding what staff ask for in the staff app, and finding cover, for GMs.

export const requestsGuide = {
  id: 'requests',
  title: 'Handle staff requests and cover',
  summary: 'Decide holiday, time off, swaps and open shifts the same day, and get sick shifts covered without a phone round.',
  Body: RequestsGuide,
};

function RequestsGuide() {
  return (
    <>
      <h3>Where they arrive</h3>
      <p>
        Planning, then Staff requests. Everything waiting for you is at the top, oldest first. Each request shows what it would
        do now: any rule it would break, shifts the person is already on, who else is off those days and, for holiday, the
        balance left after it. You only see what your role decides: holiday and availability need team management, sickness and
        time off need HR, swaps and open shifts need the right to publish the rota.
      </p>
      <p>
        Decide the same day. A request left for a week teaches the team that the app gets no answer, and they go back to
        messaging you. Anything still waiting after two days is marked Overdue and goes into your area manager's morning email
        too, with your name as the person to decide it.
      </p>

      <h3>Holiday and time off</h3>
      <ol className="guide-steps">
        <li>Check the balance after it, who else is off, and any shifts already rostered on those days.</li>
        <li>Approve, or Decline with a reason. They are told at once, in the app and by email or notification.</li>
        <li>Approved leave blocks any shift on those days. Re-cover each one, or press Put out as open shift beside it.</li>
      </ol>

      <h3>Swaps</h3>
      <ol className="guide-steps">
        <li>A colleague agrees first. Until then the swap shows Waiting for them to agree and you cannot approve it.</li>
        <li>Once agreed, check the rules line. Anything that would double book someone, break rest or young worker rules, or put them on a role they are not trained for is refused before it reaches you.</li>
        <li>Approve, and the shift moves and stays published. Both people are told.</li>
      </ol>

      <h3>Sickness</h3>
      <ol className="guide-steps">
        <li>Staff report it from their phone. It is recorded straight away, so their shifts block the rota from publishing until covered.</li>
        <li>For each shift under Shifts to cover, press Put out as open shift. Everyone trained, free and legal to work it is told.</li>
        <li>Press Seen, cover arranged once it is covered.</li>
        <li>After seven days off they need a fit note. They can photograph it in the app; only people who read HR files can open it.</li>
        <li>When they come back, hold the return to work conversation and record it in their HR file.</li>
      </ol>

      <h3>Who has seen the rota</h3>
      <p>
        After you publish, each person gets Seen it on their phone. Rota seen, on Staff requests, shows for this week and next
        who has confirmed their week as it now stands. Change a published shift and that person has to confirm again. Anyone
        marked no app cannot confirm: tell them yourself. Your morning email lists who has not seen this week's rota, and next
        week's from Friday.
      </p>

      <h3>Someone has not turned up</h3>
      <ol className="guide-steps">
        <li>Ten minutes after a shift starts with nothing clocked, the person gets a nudge on their phone and you get an email.</li>
        <li>They appear under Not clocked in at the top of Staff requests until they clock in or the shift ends.</li>
        <li>If they are not coming, press Find cover for the rest. The rest of the shift, from the next quarter hour, goes out as an open shift to everyone eligible.</li>
        <li>Their own shift stays on the rota as the no-show it was, so it counts in their record and in Staff app adoption.</li>
      </ol>
      <p>This only runs at sites where people clock in, so a missing clock means something.</p>

      <h3>Open shifts</h3>
      <ul>
        <li>Post an open shift for an extra need, such as a private party, or release one from someone who cannot work it.</li>
        <li>Only people trained for the role, set up for the site and free to work it legally are told or can claim it.</li>
        <li>
          It is offered cheapest first. First to anyone short of their contracted hours that week, whose pay you are already
          committed to. Then to the three cheapest to add. Then to everyone eligible. Each wave gets two hours, and the next only
          goes while nobody has claimed. Inside a day of the start, everyone is told at once. Tick Tell everyone eligible now, or
          press Tell everyone now on a posted shift, when speed matters more than cost.
        </li>
        <li>Claims list cheapest first, each with the wave it came from and, if you see costs, what it adds to the week's labour.</li>
        <li>Press Give it to them on one claim. The break is raised to what that person is owed, and everyone else who claimed is told it has gone.</li>
      </ul>

      <h3>Approve claims automatically</h3>
      <p>
        Below Open shifts, tick a site to let claims there approve themselves. A claim is approved the moment it is made only
        when it breaks no rule, raises nothing to review, and the site's labour for that week stays at or under its target
        share of forecast sales with the shift added. Without a forecast for the week it always waits for you. Turn it on once
        your labour targets and forecasts are ones you trust.
      </p>

      <h3>The morning email</h3>
      <p>
        Each morning you get one email listing what is waiting for you: sickness to cover, requests and how long each has
        waited, and open shifts in the week ahead still unfilled. It only comes when something is waiting, and never carries a
        reason for absence. The same switch, at the top of Staff requests, covers the not clocked in emails.
      </p>
    </>
  );
}
