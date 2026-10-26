// Getting a team onto the staff app, and what each person can do there, for GMs.

export const staffAppGuide = {
  id: 'staff-app',
  title: 'Get your team on the staff app',
  summary: 'Invite each person, help them turn on notifications, and know what they can do from their own phone.',
  Body: StaffAppGuide,
};

function StaffAppGuide() {
  return (
    <>
      <h3>Why it matters</h3>
      <p>
        The staff app is how your team sees the rota, swaps shifts, asks for time off and hears about changes. Every request
        reaches you in writing, checked against the rules, instead of by text message. It only works if everyone is on it, so
        set it up with each person on their first shift.
      </p>

      <h3>Invite each person</h3>
      <ol className="guide-steps">
        <li>Choose the site, open Clock in, then Clock-in setup.</li>
        <li>Under Phone logins, press Invite next to the person. With email set up under Settings, the link goes to their own inbox.</li>
        <li>They open the link on their phone and choose a password. The link works once and lasts seven days.</li>
        <li>Forgotten password: press Email a reset link. It only ever goes to their own email, so nobody else can sign in as them.</li>
      </ol>

      <h3>Turn on notifications, with them, on day one</h3>
      <ol className="guide-steps">
        <li>
          <strong>iPhone:</strong> open the staff app in Safari, tap the Share button, then Add to Home Screen. Open Preshift from
          the new icon. Apple only allows notifications for apps added this way, and the app says so if they skip it.
        </li>
        <li>In the app, open Inbox and press Turn on notifications, then Allow.</li>
        <li>Press Send a test. If it arrives, they are set.</li>
      </ol>
      <p>
        Phone logins shows who has notifications on, and on how many phones. Anyone marked Notifications off only hears about a
        moved shift when they next open the app or their email. Chase them.
      </p>

      <h3>Clock with a phone tag</h3>
      <p>
        A phone tag is a secure NFC sticker by the staff entrance. Staff touch the top of an iPhone, or the back of an Android
        phone, to it and are clocked in, out or back from a break. Nothing to install, no card to lose, and no location needed.
        Each touch writes a one-time code only that sticker can make, so a photo of it or a link sent to a friend at home does
        not clock anyone.
      </p>
      <ol className="guide-steps">
        <li>Under Clock-in setup, Phone tags, press Add a phone tag and program the sticker with the keys shown, or have Williams, Stanley &amp; Co. send one ready programmed.</li>
        <li>Stick it inside the entrance at hand height, away from metal and the card reader.</li>
        <li>
          On day one, have the person touch it once with you there. The phone opens Preshift in its browser: on an iPhone that is
          Safari, apart from the home screen app, so they sign in there once. After that every touch clocks them straight away.
        </li>
        <li>iPhone XS or later reads tags with the screen on. Android needs NFC turned on in settings.</li>
      </ol>

      <h3>Sign the written statement and handbook on day one</h3>
      <p>
        Every employee is entitled to a written statement of their terms on or before their first day. A tribunal can add two to
        four weeks' pay where one was not given. Do it from the phone, not on paper.
      </p>
      <ol className="guide-steps">
        <li>Open the person's personnel file from People or Onboarding, then Documents and notes. Press Add document, name it, for example Statement of particulars, and attach the PDF.</li>
        <li>Choose Written statement or Handbook and press Send to sign in the staff app. Sending the statement records it as issued that day.</li>
        <li>They get a notification, open the document in the app, tick that they have read it and type their name to sign.</li>
        <li>The record then shows when they signed, the name typed and where from. Onboarding marks the contract and handbook steps done.</li>
      </ol>
      <p>
        A signed copy cannot be changed, sent again or deleted. For a new version, add a new record. The person can open what they
        signed at any time from Inbox.
      </p>

      <h3>Reminders</h3>
      <p>
        With notifications on, each person is reminded the evening before a shift and two hours before it starts, on their phone
        only, never by email. They can turn reminders off in Inbox. They are still told if they have not clocked in ten minutes
        after the start.
      </p>

      <h3>Check it is working</h3>
      <p>
        Overview, then Staff app adoption shows, for each site: who is on the app, who has notifications on, how fast requests are
        decided, how many open shifts were filled, and no-shows. Who to chase lists names for each site. Aim for nine in ten on the
        app and seven in ten with notifications on.
      </p>

      <h3>What they can do</h3>
      <ul>
        <li><strong>Today:</strong> clock in and out inside the site's geofence or by touching the phone tag, record breaks, see today's shift and the break they are owed.</li>
        <li><strong>Seen it:</strong> when a week is published or changes, a banner asks them to check their shifts and confirm.</li>
        <li><strong>Rota:</strong> their shifts for the next two weeks and who they are on with. Swap or give away a shift, and pick up open shifts and swaps offered to them.</li>
        <li><strong>Requests:</strong> holiday with their balance shown first, other time off, report sickness and send a fit note, change their usual week, and add days they cannot work.</li>
        <li><strong>Inbox:</strong> every message about their rota and requests, the documents they have signed, and the notifications switch.</li>
        <li><strong>To read and sign:</strong> a banner on every tab while a document sent to them is unsigned.</li>
      </ul>
      <p>They never see pay, anyone else's records, or anyone's reason for being off.</p>

      <h3>Shared phones and leavers</h3>
      <ul>
        <li>Signing out of a phone turns its notifications off, so a borrowed phone stops getting their rota.</li>
        <li>Marking someone as a leaver, or pressing Close beside their phone login, ends their access and their notifications at once.</li>
      </ul>
    </>
  );
}
