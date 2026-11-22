/** @jest-environment node */

import { isAllowedSitePublicS3Key } from "@/utils/server/sitePublicS3Key";

describe("isAllowedSitePublicS3Key", () => {
  const siteId = "ananda";

  it("allows keys under public/", () => {
    expect(isAllowedSitePublicS3Key("public/pdf/test-library/doc.pdf", siteId)).toBe(true);
    expect(isAllowedSitePublicS3Key("public/audio/test-library/talk.mp3", siteId)).toBe(true);
  });

  it("allows keys under the site public prefix", () => {
    expect(isAllowedSitePublicS3Key("ananda/public/pdf/test-library/doc.pdf", siteId)).toBe(true);
  });

  it("rejects keys for another site prefix", () => {
    expect(isAllowedSitePublicS3Key("crystal/public/pdf/test-library/doc.pdf", siteId)).toBe(false);
    expect(isAllowedSitePublicS3Key("jairam/public/audio/test-library/talk.mp3", siteId)).toBe(false);
  });

  it("rejects path-traversal keys", () => {
    expect(isAllowedSitePublicS3Key("public/pdf/../secret.pdf", siteId)).toBe(false);
    expect(isAllowedSitePublicS3Key("../public/pdf/test-library/doc.pdf", siteId)).toBe(false);
    expect(isAllowedSitePublicS3Key("ananda/public/pdf/../../secret.pdf", siteId)).toBe(false);
  });

  it("rejects absolute keys", () => {
    expect(isAllowedSitePublicS3Key("/public/pdf/test-library/doc.pdf", siteId)).toBe(false);
    expect(isAllowedSitePublicS3Key("\\public\\pdf\\doc.pdf", siteId)).toBe(false);
  });

  it("rejects keys outside the public prefix", () => {
    expect(isAllowedSitePublicS3Key("private/pdf/test-library/doc.pdf", siteId)).toBe(false);
    expect(isAllowedSitePublicS3Key("site-config/prompts/secret.pdf", siteId)).toBe(false);
    expect(isAllowedSitePublicS3Key("test.pdf", siteId)).toBe(false);
  });
});
