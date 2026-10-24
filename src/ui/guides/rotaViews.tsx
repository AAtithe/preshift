// The rota views guide for GMs: which view answers which question, and the habit that makes them pay.

export const rotaViewsGuide = {
  id: 'rota-views',
  title: 'Reading the week eight ways',
  summary: 'Which rota view answers which question, in the order to use them before a week goes out.',
  Body: RotaViewsGuide,
};

function RotaViewsGuide() {
  return (
    <>
      <h3>One question per view</h3>
      <p>
        Every view on the Rota tab is the same week, costed and checked the same way. Each one is built to answer a single
        question. Pick the view for the decision in front of you, not the one you are used to.
      </p>
      <dl className="guide-faq">
        <dt>Service timeline</dt>
        <dd>Is each day staffed to its sales curve? Use it to build and to drag shifts.</dd>
        <dt>By person</dt>
        <dd>What is each person's week? Use it to move a shift to someone else or another day.</dd>
        <dt>Cover map</dt>
        <dd>
          Where do I add or cut the next hour? The whole week in one grid: coral is short, gold is paid for and not needed. Click
          a coral hour to put someone on it. A coral column across every day is a demand rule or a hiring signal, not a rota
          problem.
        </dd>
        <dt>Rest</dt>
        <dd>
          Who is being worn down? Last week and this as one line per person, at every site they work. Coral rest is under the
          legal minimum and will block publication; gold is legal but within two hours of it. Look at the top of the list first:
          it is sorted shortest rest first.
        </dd>
        <dt>Positions</dt>
        <dd>
          Is every position held? One day by role and hour. Enough people on can still mean nobody on the door at 21:00. A coral
          cell says Nobody where the forecast needs someone.
        </dd>
        <dt>Shift cost</dt>
        <dd>
          Which shift do I cut when labour is over? Each shift is a brick as wide as its loaded cost, in the order the day runs.
          The dashed line is the spend that keeps the day on target; whatever runs past it is hatched. Only people who may see
          pay are offered this view.
        </dd>
        <dt>Changes</dt>
        <dd>
          Who will a change reach? After a week is published, this lists everyone the next publish will message and exactly
          what they will be told. Read it before you press publish again.
        </dd>
        <dt>Fairness</dt>
        <dd>
          Who keeps getting the hard shifts? Four weeks of weekends, closes, finishes after midnight and hours under contract.
          A coral dot carries at least double the team average. Only weeks with a rota at the site count.
        </dd>
      </dl>

      <h3>The habit: four checks before a week goes out</h3>
      <ol className="guide-steps">
        <li><strong>Cover map.</strong> Clear the coral you can, and cut the gold that is just cost.</li>
        <li><strong>Rest.</strong> No coral, and talk to anyone in gold two weeks running.</li>
        <li><strong>Fairness.</strong> If one name is coral, give their closes to someone else this week.</li>
        <li><strong>Changes.</strong> On a week already out, check every change is worth the message it sends.</li>
      </ol>

      <h3>What staff see</h3>
      <p>
        In the staff app, the Rota tab shows the next two weeks as a strip with their hours, pay before tax for hourly staff,
        shortest rest and days off. Each shift shows who is on with them and who they close with, and each open shift says
        what it would do to their week before they ask for it. They see their own pay only, and never anyone else's.
      </p>
    </>
  );
}
