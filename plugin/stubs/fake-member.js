// Test-only member. Never loads a CLI or credentials.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [instruction = '', heartbeat] = process.argv.slice(2);
const beat = () => { if (heartbeat) appendFileSync(heartbeat, `${process.pid}\n`); };
if (instruction === 'child') {
  beat(); setInterval(beat, 30);
} else if (instruction === 'sleep') {
  beat(); setInterval(beat, 30);
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', heartbeat], {
    stdio: 'ignore', shell: false, windowsHide: true,
  });
  setTimeout(() => process.exit(0), 5000);
} else if (instruction === 'flood') {
  process.stdout.write('x'.repeat(1024 * 1024));
} else if (instruction === 'fail') {
  process.stderr.write('fake failure'); process.exitCode = 7;
} else if (instruction === 'empty') {
  console.log('{"type":"tool.output","text":"not an answer"}');
} else if (instruction === 'cat') {
  console.log(JSON.stringify({ status: 'SUCCESS', response: 'Antigravity假程序回答' }));
} else {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: instruction } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 } }));
}
