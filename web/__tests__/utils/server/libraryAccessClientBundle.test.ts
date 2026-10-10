import fs from "fs";
import path from "path";

const webRoot = path.join(__dirname, "../../..");

function readWebFile(rel: string): string {
  return fs.readFileSync(path.join(webRoot, rel), "utf8");
}

describe("library access client bundle", () => {
  test("the client _app path does not import jsonwebtoken", () => {
    const appSource = readWebFile("src/pages/_app.tsx");
    const accessSource = readWebFile("src/utils/server/libraryAccess.ts");
    const appPropsSource = readWebFile("src/utils/server/libraryAccessAppProps.ts");
    expect(appSource).not.toMatch(/jsonwebtoken/);
    expect(appSource).not.toMatch(/libraryAccessAuth/);
    expect(appPropsSource).not.toMatch(/from ["']jsonwebtoken["']/);
    expect(appPropsSource).not.toMatch(/from ["']\.\/libraryAccessAuth["']/);
    expect(appPropsSource).toMatch(/import\(["']\.\/libraryAccessAuth["']\)/);
    expect(accessSource).not.toMatch(/jsonwebtoken/);
    expect(accessSource).not.toMatch(/from ["']crypto["']/);
  });

  test("the built client _app chunk has no jsonwebtoken when a production build exists", () => {
    const chunksDir = path.join(webRoot, ".next/static/chunks/pages");
    if (!fs.existsSync(chunksDir)) {
      return;
    }
    const appChunks = fs.readdirSync(chunksDir).filter((name) => name.startsWith("_app-") && name.endsWith(".js"));
    expect(appChunks.length).toBeGreaterThan(0);
    const forbidden = ["jsonwebtoken", "crypto-browserify", "node_modules/jws", "node_modules/jwa"];
    for (const chunk of appChunks) {
      const source = fs.readFileSync(path.join(chunksDir, chunk), "utf8");
      for (const token of forbidden) {
        expect(source).not.toContain(token);
      }
    }
  });

  test("the chat route still calls applyLibraryAccessGate", () => {
    const routeSource = readWebFile("src/app/api/chat/v1/route.ts");
    expect(routeSource).toMatch(/applyLibraryAccessGate/);
    expect(routeSource).toMatch(/token\.email/);
  });

  test("the access module has no dynamic process.env lookup", () => {
    const accessFiles = [
      "src/utils/server/libraryAccess.ts",
      "src/utils/server/libraryAccessAuth.ts",
      "src/utils/server/libraryAccessAppProps.ts",
      "src/utils/server/libraryAccessMiddlewareGate.ts",
    ];
    for (const rel of accessFiles) {
      const withoutComments = readWebFile(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(withoutComments).not.toMatch(/process\.env\s*\[/);
    }
  });
});
