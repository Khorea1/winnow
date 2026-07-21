import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DIR = import.meta.dirname;
const PARTIALS_DIR = join(DIR, "..", "public", "html");
const OUTPUT = join(DIR, "..", "public", "dashboard.html");

async function assemble() {
  let entries;
  try {
    entries = await readdir(PARTIALS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(`Failed to read partials directory: ${PARTIALS_DIR}`, err);
    process.exit(1);
  }

  const collator = new Intl.Collator("en", { numeric: true });
  const htmlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".html"))
    .map((e) => e.name)
    .sort(collator.compare);
  if (htmlFiles.length === 0) {
    console.error(`No .html partials found in ${PARTIALS_DIR}`);
    process.exit(1);
  }

  const chunks = await Promise.all(
    htmlFiles.map((name) =>
      readFile(join(PARTIALS_DIR, name), "utf-8").catch((err) => {
        console.error(`Failed to read partial: ${name}`, err);
        process.exit(1);
      }),
    ),
  );

  const html = chunks.join("");

  await writeFile(OUTPUT, html, "utf-8");
  console.log(`Assembled ${htmlFiles.length} partials → ${OUTPUT}`);
}

await assemble();
