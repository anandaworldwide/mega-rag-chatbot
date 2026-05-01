import {
  buildPineconeAccessFilter,
  buildPineconeAccessFilterClauses,
  getAccessLevelLabel,
  getAccessLevelValueForKey,
  resolveEffectiveAccessLevel,
  validateManualAccessLevel,
} from "@/utils/server/accessLevelUtils";
import type { SiteConfig } from "@/types/siteConfig";

const siteConfig = {
  siteId: "ananda",
  accessControl: {
    enabled: true,
    defaultLevel: 0,
    superuserLevel: 9999,
    manualAssignmentCaps: {
      userAdminMaxLevel: 500,
      superuserMaxLevel: 9999,
    },
    salesforceOnlyLevels: [600, 700],
    levels: [
      { key: "public", label: "Public", value: 0 },
      { key: "disciple", label: "Disciple", value: 100 },
      { key: "kriyaban", label: "Kriyaban", value: 200 },
      { key: "ananda_library_access", label: "Ananda Library Access", value: 300 },
      { key: "second_kriya", label: "Second Kriya", value: 400 },
      {
        key: "third_and_fourth_kriya",
        label: "Third and Fourth Kriya",
        value: 500,
      },
      { key: "minister", label: "Minister", value: 600 },
      { key: "lightbearer", label: "Lightbearer", value: 700 },
      { key: "admin", label: "Admin", value: 9999 },
    ],
  },
} as SiteConfig;

describe("accessLevelUtils", () => {
  it("normalizes configured access level keys into numeric values", () => {
    expect(getAccessLevelValueForKey("third_and_fourth_kriya", siteConfig)).toBe(500);
    expect(getAccessLevelValueForKey("kriyaban", siteConfig)).toBe(200);
    expect(getAccessLevelValueForKey("third_kriya", siteConfig)).toBeNull();
  });

  it("resolves local superusers before Salesforce values", () => {
    const effective = resolveEffectiveAccessLevel(
      {
        role: "superuser",
        salesforceAccessLevel: 0,
        manualAccessLevel: 200,
      },
      siteConfig
    );

    expect(effective).toEqual({
      level: 9999,
      label: "Superuser",
      source: "superuser",
    });
  });

  it("uses Salesforce before manual values for non-superusers", () => {
    const effective = resolveEffectiveAccessLevel(
      {
        role: "user",
        salesforceId: "0031I00000ILXk1QAH",
        salesforceMatchStatus: "matched",
        salesforceAccessLevel: "600",
        manualAccessLevel: 500,
      },
      siteConfig
    );

    expect(effective.level).toBe(600);
    expect(effective.source).toBe("salesforce");
    expect(getAccessLevelLabel(effective.level, siteConfig)).toBe("Minister");
  });

  it("does not let a Salesforce NA response override manual access", () => {
    const effective = resolveEffectiveAccessLevel(
      {
        role: "user",
        salesforceId: "NA",
        salesforceMatchStatus: "not_found",
        salesforceAccessLevel: 0,
        manualAccessLevel: 500,
      },
      siteConfig
    );

    expect(effective.level).toBe(500);
    expect(effective.source).toBe("manual");
  });

  it("blocks user admins from assigning Salesforce-only levels", () => {
    const result = validateManualAccessLevel(600, "admin", siteConfig);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Salesforce");
  });

  it("builds numeric and legacy-compatible Pinecone filters", () => {
    expect(buildPineconeAccessFilter(500, siteConfig)).toEqual({
      $and: [
        {
          $or: [{ required_access_level: { $exists: false } }, { required_access_level: { $lte: 500 } }],
        },
        {
          access_level: {
            $nin: ["minister", "lightbearer", "admin"],
          },
        },
      ],
    });
  });

  it("builds flat Pinecone access clauses for parent $and filters", () => {
    const filter = {
      $and: [{ type: { $in: ["text"] } }, ...buildPineconeAccessFilterClauses(500, siteConfig)],
    };

    expect(filter).toEqual({
      $and: [
        { type: { $in: ["text"] } },
        {
          $or: [{ required_access_level: { $exists: false } }, { required_access_level: { $lte: 500 } }],
        },
        {
          access_level: {
            $nin: ["minister", "lightbearer", "admin"],
          },
        },
      ],
    });
    expect(filter.$and.some((clause) => "$and" in clause)).toBe(false);
  });

  it("does not restrict sites without enabled access control", () => {
    expect(buildPineconeAccessFilter(0, { siteId: "crystal" } as SiteConfig)).toBeNull();
    expect(buildPineconeAccessFilterClauses(0, { siteId: "crystal" } as SiteConfig)).toEqual([]);
  });
});
