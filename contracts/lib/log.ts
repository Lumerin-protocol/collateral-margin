import readline from "node:readline";

const STEP_WIDTH = 30;

export function logTitle(title: string): void {
  console.log(`\n--- ${title} ---\n`);
}

export function logInfo(label: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  const maxKeyLen = Math.max(...keys.map((k) => k.length));
  console.log(`\n[${label}]`);
  for (const [k, v] of Object.entries(fields)) {
    console.log(`  ${k.padEnd(maxKeyLen)}  ${v}`);
  }
}

export function logStep(name: string, result: string): void {
  const dots = ".".repeat(Math.max(4, STEP_WIDTH - name.length));
  console.log(`* ${name} ${dots} ${result}`);
}

export function logSuccess(message: string): void {
  console.log(`\n--- SUCCESS: ${message} ---\n`);
}

export async function logPrompt(message: string): Promise<void> {
  if (!process.stdin.isTTY) return;
  await prompt(`\n${message} [Enter to continue] `);
}

function prompt(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}
