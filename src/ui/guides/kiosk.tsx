// Setting up a shared iPad as a site's clocking kiosk, for GMs.

export const kioskGuide = {
  id: 'kiosk',
  title: 'Set up a kiosk iPad',
  summary: 'Turn a shared iPad at the staff entrance into a screen that clocks people in and out, and nothing else.',
  Body: KioskGuide,
};

function KioskGuide() {
  return (
    <>
      <h3>Why a kiosk</h3>
      <p>
        A shared iPad signed in as a manager is a risk: anyone passing can open pay, people's records and the rota. A kiosk can
        only clock people in and out at one site. It stays set up for a year, so nobody has to sign in on it before service.
      </p>

      <h3>Set it up, once, on the iPad itself</h3>
      <ol className="guide-steps">
        <li>On the iPad, open Preshift in Safari and sign in as yourself.</li>
        <li>Choose the site, open Clock in, then Clock-in setup.</li>
        <li>Under Kiosks, press Turn this device into a kiosk, name it (for example, Staff entrance iPad) and confirm.</li>
        <li>
          The iPad opens the kiosk and <strong>you are signed out of it</strong>. That is deliberate: the iPad must never stay
          signed in as you.
        </li>
        <li>
          Lock the iPad to the kiosk with Guided Access: Settings, Accessibility, Guided Access, turn it on and set a passcode
          only managers know. Then on the kiosk, press the side button three times to start it.
        </li>
        <li>Plug in a USB card reader if your team uses cards, and keep the iPad on charge.</li>
      </ol>

      <h3>How staff use it</h3>
      <ul>
        <li><strong>With a card:</strong> hold it to the reader. Tap once to clock in, once to clock out. Tapping during a break ends the break.</li>
        <li>
          <strong>Without a card:</strong> tap their name, then Clock in, Start break, End break or Clock out. Only people on
          today's rota at this site are listed. If someone is missing, add their shift to the rota.
        </li>
      </ul>
      <p>Each clock is recorded against the kiosk's name, so you can see on the time entry where and how it was made.</p>

      <h3>PINs</h3>
      <ul>
        <li>Staff choose their own PIN in the staff app, under Kiosk PIN. That is the best way: nobody else ever knows it.</li>
        <li>
          For someone without the staff app, press Issue PIN next to their name in Clock-in setup and give it to them in person.
          It is shown once and cannot be looked up later.
        </li>
        <li>PINs like 1234, one digit repeated, or the person's date of birth are refused.</li>
        <li>Five wrong tries lock that person's PIN for 15 minutes. Their card still works, and a new PIN from you clears the lock.</li>
        <li>Forgotten PIN: issue a new one, or they set a new one in the staff app.</li>
      </ul>

      <h3>If the iPad is lost, replaced or moved</h3>
      <p>
        On your own device, open Clock in, Clock-in setup, and press Remove next to the kiosk. It stops working at once. Set up
        the new iPad the same way. Last seen tells you whether a kiosk is still switched on and connected.
      </p>

      <h3>Good to know</h3>
      <ul>
        <li>
          Without PINs, anyone at the iPad can tap a colleague's name. Turn on Require a PIN under Clock-in setup, then sign-in by
          name needs the person's own PIN. Cards are not affected and stay the quickest way in.
        </li>
        <li>The kiosk keeps the screen awake where the iPad allows it. Set Auto-Lock to Never as well.</li>
        <li>If the wifi drops, the kiosk says so and tries again every minute. Clocks made while it is offline are not saved, so use a manual entry for anyone affected.</li>
      </ul>
    </>
  );
}
