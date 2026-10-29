// Clocking by touching a phone to a secure NFC tag at the staff entrance, for GMs.

export const phoneTagsGuide = {
  id: 'phone-tags',
  title: 'Clock in with a phone tag',
  summary: 'Put a secure NFC sticker at the staff entrance so staff clock in and out by touching it with their own phone.',
  Body: PhoneTagsGuide,
};

function PhoneTagsGuide() {
  return (
    <>
      <h3>Why a phone tag</h3>
      <p>
        Cards get lost, lent and left at home. Clocking by location fails in basements, cellars and on poor signal. A phone tag
        uses the one thing every member of staff already carries. They touch their phone to the sticker and are clocked in, out,
        or back from a break, whichever comes next. Nothing to install, no location needed, iPhone or Android.
      </p>
      <p>
        Every touch writes a one-time code only that sticker can make. A photo of the sticker, a copied link, or a link sent to a
        friend at home clocks nobody. The staff login proves who; the sticker proves where.
      </p>

      <h3>What you need</h3>
      <ul>
        <li>One NTAG 424 DNA sticker per entrance. Other NFC stickers will not work: they cannot write a one-time code.</li>
        <li>Each person on the staff app, with their own login. Invite them under Clock-in setup, Phone logins.</li>
        <li>Phones that read NFC: iPhone XS or later, or an Android phone with NFC turned on.</li>
        <li>To program the sticker yourself: NXP TagXplorer on a computer with a USB NFC reader, or NXP TagWriter on a phone. Your accounting partner can send stickers ready programmed instead.</li>
      </ul>

      <h3>Add the tag in Preshift</h3>
      <ol className="guide-steps">
        <li>Choose the site, open Clock in, then Clock-in setup.</li>
        <li>Under Phone tags, name it (for example, Staff entrance) and press Add a phone tag.</li>
        <li>
          Preshift shows the address to write and two keys. <strong>The keys are shown once.</strong> Program the sticker now,
          or send them securely to whoever is programming it. If they are lost, remove the tag and add it again.
        </li>
      </ol>

      <h3>Program the sticker</h3>
      <ol className="guide-steps">
        <li>Write the address Preshift shows as a URL record.</li>
        <li>Turn on Secure Unique NFC (SDM) for that file, with reading free and the read counter on.</li>
        <li>Mirror the UID and read counter, encrypted, over the 32 zeros after picc=, using the SDM meta read key.</li>
        <li>Place the MAC over the 16 zeros after cmac=, with the MAC input starting at the same place, using the SDM file read key.</li>
        <li>Change the sticker's own application keys from the factory default, so nobody can reprogram it.</li>
      </ol>

      <h3>Put it up and test it</h3>
      <ol className="guide-steps">
        <li>Stick it inside the entrance at hand height, away from metal frames and the card reader. Metal behind a sticker stops it reading.</li>
        <li>Ask someone with a staff login to touch it. Their phone opens Preshift and says Clocked in.</li>
        <li>Clock-in setup now shows the sticker's serial and the time it was last touched. A sticker that has never been touched shows Not yet.</li>
        <li>Touch it again after two minutes to clock out, then check the entry under Clock in shows (phone tag).</li>
      </ol>

      <h3>The first touch, with each person</h3>
      <ol className="guide-steps">
        <li><strong>iPhone:</strong> hold the top of the phone to the sticker with the screen on. A banner appears; tap it.</li>
        <li><strong>Android:</strong> unlock the phone and hold the middle of the back to the sticker. NFC must be on in settings.</li>
        <li>
          The phone opens Preshift in its browser. On an iPhone that is Safari, which does not share a login with the staff app on
          the home screen, so they sign in once there. The touch is recorded as soon as they do. From then on every touch clocks
          them straight away.
        </li>
        <li>Do this with them on day one. It takes a minute and saves a week of "it didn't work".</li>
      </ol>

      <h3>What staff will see</h3>
      <ul>
        <li><strong>Clocked in at 09:00 at the site:</strong> the first touch of the day.</li>
        <li><strong>Welcome back, break ended:</strong> a touch while on a break.</li>
        <li><strong>Clocked out:</strong> a touch while clocked in and not on a break.</li>
        <li><strong>Already clocked in:</strong> a second touch within two minutes. It counts once, not as a clock-out.</li>
        <li><strong>This tap has been used already:</strong> they reopened an old page or link. Touch the sticker again.</li>
        <li><strong>Not set up to work at this site:</strong> they have no shift there today and it is not their home or cover site. Add it as a cover site under People.</li>
      </ul>

      <h3>When something goes wrong</h3>
      <ul>
        <li><strong>Nothing happens on touch:</strong> NFC is off (Android), the phone is too old, or metal is behind the sticker.</li>
        <li><strong>This tap could not be checked:</strong> the sticker was programmed with the wrong keys or settings. Program it again, or remove the tag and add a new one.</li>
        <li><strong>A sticker is lost, damaged or tampered with:</strong> press Remove under Phone tags. Touches on it stop working at once. Add a new one.</li>
        <li><strong>A missed clock:</strong> add a manual entry for approval, as with any other clocking method.</li>
      </ul>
    </>
  );
}
