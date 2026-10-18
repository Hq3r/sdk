import { readFileSync, writeFileSync } from "node:fs";
import { compile } from "@fleet-sdk/compiler";

const contracts = [
  {
    source: "src/contracts/limit/e2t-limit-order.es",
    target: "src/limit-order.ts",
    key: "E2T",
    type: "E2T",
  },
  {
    source: "src/contracts/grid/e2t-grid-order.es",
    target: "src/grid-order.ts",
    key: "E2T",
    type: "E2T",
  },
  {
    source: "src/contracts/grid/t2t-grid-order.es",
    target: "src/grid-order.ts",
    key: "T2T",
    type: "T2T",
  },
];

for (const contract of contracts) {
  const tree = compile(readFileSync(contract.source, "utf8")).toHex();
  const target = readFileSync(contract.target, "utf8");
  const pattern = new RegExp(
    `(${contract.key}: new OrderContract\\(\\s*)"[0-9a-f]+"(\\s*,\\s*"${contract.type}")`,
  );
  if (!pattern.test(target)) throw new Error(`Contract constant not found in ${contract.target}`);
  writeFileSync(contract.target, target.replace(pattern, `$1"${tree}"$2`));
  console.log(`${contract.source}: ${tree}`);
}
