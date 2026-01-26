import { generatePrompt } from "@/utils/client/promptGenerator";

describe("promptGenerator", () => {
  describe("generatePrompt", () => {
    it("should replace simple variables", () => {
      const template = "Hello {{name}}!";
      const values = { name: "World" };
      expect(generatePrompt(template, values)).toBe("Hello World!");
    });

    it("should handle missing variables", () => {
      const template = "Hello {{name}}!";
      const values = {};
      expect(generatePrompt(template, values)).toBe("Hello !");
    });

    it("should handle conditional blocks with truthy values", () => {
      const template = "Start{{#show}} visible{{/show}} end";
      const values = { show: true };
      expect(generatePrompt(template, values)).toBe("Start visible end");
    });

    it("should handle conditional blocks with falsy values", () => {
      const template = "Start{{#show}} visible{{/show}} end";
      const values = { show: false };
      expect(generatePrompt(template, values)).toBe("Start end");
    });

    it("should handle inverse blocks with falsy values", () => {
      const template = "Start{{^show}} hidden{{/show}} end";
      const values = { show: false };
      expect(generatePrompt(template, values)).toBe("Start hidden end");
    });

    it("should handle inverse blocks with truthy values", () => {
      const template = "Start{{^show}} hidden{{/show}} end";
      const values = { show: true };
      expect(generatePrompt(template, values)).toBe("Start end");
    });

    it("should handle literal \\n sequences and convert to newlines", () => {
      // Simulating a template with literal \n (backslash + n)
      const template = "Line 1.\\n\\nLine 2.";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toContain("\n\n");
      expect(result).toBe("Line 1.\n\nLine 2.");
    });

    it("should add paragraph break after period followed by capital letter", () => {
      const template = "First sentence.Second sentence.";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toBe("First sentence.\n\nSecond sentence.");
    });

    it("should add space after period followed by lowercase letter", () => {
      const template = "e.g.example";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toBe("e. g. example");
    });

    it("should fix colon followed by number (numbered list)", () => {
      const template = "Please provide:1. First item";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toBe("Please provide:\n\n1. First item");
    });

    it("should add space after numbered list item", () => {
      const template = "1.First item";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toBe("1. First item");
    });

    it("should separate consecutive numbered list items", () => {
      const template = "Items:1. First2. Second3. Third";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toContain("1. First\n2. Second\n3. Third");
    });

    it("should handle the social media task template pattern", () => {
      // Simulate the social-media.json template with some conditionals removed
      const template =
        'Create content for {{platform}} about "{{topic}}".{{#tone}}\n\nTone: {{tone}}.{{/tone}}{{#length}}\n\nLength: {{length}}.{{/length}}{{#includeQuote}}\n\nPlease include a relevant quote.{{/includeQuote}}\n\nPlease provide:\n\n1. The main post\n2. Suggested hashtags\n3. A call to action';

      const values = {
        platform: "instagram",
        topic: "Republic Day",
        tone: "", // empty - conditional removed
        length: "1-2 sentences",
        includeQuote: true,
      };

      const result = generatePrompt(template, values);

      // Should have proper paragraph breaks
      expect(result).toContain('"Republic Day".\n\n');
      expect(result).toContain("Length: 1-2 sentences.\n\n");
      expect(result).toContain("Please include a relevant quote.\n\n");
      expect(result).toContain("Please provide:\n\n1. The main post");

      // Should NOT have periods running into words
      expect(result).not.toMatch(/\.\w/);
    });

    it("should handle template with all conditionals empty", () => {
      const template =
        'Create content for {{platform}} about "{{topic}}".{{#tone}}\n\nTone: {{tone}}.{{/tone}}{{#length}}\n\nLength: {{length}}.{{/length}}\n\nPlease provide:\n\n1. Item one\n2. Item two';

      const values = {
        platform: "facebook",
        topic: "Joy",
        tone: "",
        length: "",
      };

      const result = generatePrompt(template, values);

      // Check that removed conditionals don't leave awkward formatting
      expect(result).toContain('"Joy".\n\nPlease provide:');
      expect(result).toContain("Please provide:\n\n1. Item one");
    });

    it("should normalize excessive newlines", () => {
      const template = "Line 1.\n\n\n\n\nLine 2.";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toBe("Line 1.\n\nLine 2.");
    });

    it("should remove trailing spaces on lines", () => {
      const template = "Line 1.   \n\nLine 2.";
      const values = {};
      const result = generatePrompt(template, values);
      expect(result).toBe("Line 1.\n\nLine 2.");
    });

    it("should handle complex nested conditionals", () => {
      const template =
        "Start.{{#a}}\n\nA content.{{/a}}{{#b}}\n\nB content.{{/b}}{{#c}}\n\nC content.{{/c}}\n\nEnd.";

      const values = {
        a: false,
        b: true,
        c: false,
      };

      const result = generatePrompt(template, values);
      expect(result).toBe("Start.\n\nB content.\n\nEnd.");
    });

    it("should handle the exact Republic Day scenario from user report", () => {
      // This is the exact template from social-media.json
      const template =
        'Create content for {{platform}} about "{{topic}}".{{#tone}}\n\nTone: {{tone}}.{{/tone}}{{#length}}\n\nLength: {{length}}.{{/length}}{{#includeQuote}}\n\nPlease include a relevant quote from Master or Swamiji.{{/includeQuote}}{{#additionalDetails}}\n\nAdditional details: {{additionalDetails}}{{/additionalDetails}}\n\nPlease provide:\n\n1. The main post/content\n2. Suggested hashtags (if applicable)\n3. A call to action if appropriate\n\nMake it engaging and authentic to the Ananda spirit.';

      const values = {
        platform: "instagram",
        topic: "Republic Day",
        tone: "", // Empty - conditional removed
        length: "1-2 sentence",
        includeQuote: true,
        additionalDetails: "", // Empty - conditional removed
      };

      const result = generatePrompt(template, values);

      // The result should be well-formatted with proper paragraph breaks
      const expectedResult = `Create content for instagram about "Republic Day".

Length: 1-2 sentence.

Please include a relevant quote from Master or Swamiji.

Please provide:

1. The main post/content
2. Suggested hashtags (if applicable)
3. A call to action if appropriate

Make it engaging and authentic to the Ananda spirit.`;

      expect(result).toBe(expectedResult);
    });
  });
});
