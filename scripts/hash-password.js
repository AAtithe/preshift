// Prints an APP_USERS entry: npm run hash-password -- name@example.com [organisation id]
// The password is read from the terminal without echoing, so it never lands in shell history.
import { createInterface } from 'node:readline';
import { DEFAULT_ORG, hashPassword } from '../server/passwords';

const [email, orgId = DEFAULT_ORG] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('Usage: npm run hash-password -- name@example.com [organisation id]');
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(prompt) ? s : '');
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = process.stdin.isTTY ? await ask('Password: ') : (await new Response(process.stdin).text()).trim();
if (password.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}
console.log(`${email.toLowerCase()}:${await hashPassword(password)}:${orgId}`);
