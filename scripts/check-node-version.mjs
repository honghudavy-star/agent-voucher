const major = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);

if (major !== 24) {
  console.error(`Agent Voucher requires Node.js 24 LTS; current runtime is ${process.version}.`);
  process.exit(1);
}
