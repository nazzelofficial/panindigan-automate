import fs from "node:fs";
const s = fs.readFileSync("node_modules/mqtt/dist/mqtt.esm.js", "utf8");
for (const p of ["_emitError(e){", "_emitError(t){", "emit(\"error\",e)", "parser.on(\"error\"", "newParser("]) {
  let from = 0, n = 0;
  console.log("===", p);
  while (n < 5) {
    const i = s.indexOf(p, from);
    if (i < 0) break;
    console.log(" idx", i, ":", s.slice(Math.max(0, i - 160), i + 280).replace(/\n/g, " "));
    from = i + p.length;
    n++;
  }
}
