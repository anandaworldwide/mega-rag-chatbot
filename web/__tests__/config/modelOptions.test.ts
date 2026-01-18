import { MODEL_OPTIONS, DEFAULT_MODEL, ModelOption } from "@/config/modelOptions";

describe("modelOptions", () => {
  describe("MODEL_OPTIONS", () => {
    it("should be an array", () => {
      expect(Array.isArray(MODEL_OPTIONS)).toBe(true);
    });

    it("should contain at least one model option", () => {
      expect(MODEL_OPTIONS.length).toBeGreaterThan(0);
    });

    it("should have all required model options", () => {
      const expectedModels = [
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo",
      ];

      const actualValues = MODEL_OPTIONS.map((opt) => opt.value);
      expectedModels.forEach((expected) => {
        expect(actualValues).toContain(expected);
      });
    });

    it("should have valid ModelOption structure for each option", () => {
      MODEL_OPTIONS.forEach((option) => {
        expect(option).toHaveProperty("value");
        expect(option).toHaveProperty("label");
        expect(typeof option.value).toBe("string");
        expect(typeof option.label).toBe("string");
        expect(option.value.length).toBeGreaterThan(0);
        expect(option.label.length).toBeGreaterThan(0);
      });
    });

    it("should have unique model values", () => {
      const values = MODEL_OPTIONS.map((opt) => opt.value);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });

    it("should have unique model labels", () => {
      const labels = MODEL_OPTIONS.map((opt) => opt.label);
      const uniqueLabels = new Set(labels);
      expect(uniqueLabels.size).toBe(labels.length);
    });
  });

  describe("DEFAULT_MODEL", () => {
    it("should be a string", () => {
      expect(typeof DEFAULT_MODEL).toBe("string");
    });

    it("should not be empty", () => {
      expect(DEFAULT_MODEL.length).toBeGreaterThan(0);
    });

    it("should be one of the available model options", () => {
      const availableValues = MODEL_OPTIONS.map((opt) => opt.value);
      expect(availableValues).toContain(DEFAULT_MODEL);
    });

    it("should be gpt-4.1-mini", () => {
      expect(DEFAULT_MODEL).toBe("gpt-4.1-mini");
    });
  });

  describe("ModelOption interface", () => {
    it("should match the expected structure", () => {
      const sampleOption: ModelOption = {
        value: "test-model",
        label: "Test Model",
      };

      expect(sampleOption).toHaveProperty("value");
      expect(sampleOption).toHaveProperty("label");
      expect(typeof sampleOption.value).toBe("string");
      expect(typeof sampleOption.label).toBe("string");
    });
  });
});
