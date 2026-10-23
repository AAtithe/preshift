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
        messaging you.
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

      <h3>Open shifts</h3>
      <ul>
        <li>Post an open shift for an extra need, such as a private party, or release one from someone who cannot work it.</li>
        <li>Only people trained for the role, set up for the site and free to work it legally are told or can claim it.</li>
        <li>Press Give it to them on one claim. The break is raised to what that person is owed, and everyone else who claimed is told it has gone.</li>
      </ul>

      <h3>The morning email</h3>
      <p>
        Each morning you get one email listing what is waiting for you: sickness to cover, requests and how long each has
        waited, and open shifts in the week ahead still unfilled. It only comes when something is waiting, and never carries a
        reason for absence. Turn it off or on at the top of Staff requests.
      </p>
    </>
  );
}
