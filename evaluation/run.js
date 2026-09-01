const fs = require('node:fs');
const path = require('node:path');
const { decideOnOrder } = require('../agent');

async function main() {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
  const results = [];
  for (const item of cases) {
    const actual = (await decideOnOrder(item.message)).decision;
    results.push({ ...item, actual, correct: actual === item.expected });
  }
  const correct = results.filter(item => item.correct).length;
  const metrics = {
    total: results.length,
    correct,
    accuracy: Number((correct / results.length).toFixed(3)),
    byDecision: Object.fromEntries([...new Set(cases.map(item => item.expected))].map(label => {
      const subset = results.filter(item => item.expected === label);
      return [label, { total: subset.length, correct: subset.filter(item => item.correct).length }];
    })),
    generatedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify({ metrics, results }, null, 2));
  if (correct !== results.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
