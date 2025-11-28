/**
 * Unit tests for SSRF protection utilities
 * Tests URL validation, domain whitelisting, and safe fetch functionality
 */

import { validateUrlForSSRF, safeFetch, sanitizeUrlForLogging } from "@/utils/server/ssrfProtection";

// Mock fetch globally
global.fetch = jest.fn();

describe("SSRF Protection", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Clear environment variable
    delete process.env.SSRF_ALLOWED_DOMAINS;
  });

  describe("validateUrlForSSRF", () => {
    describe("valid URLs - allowed domains", () => {
      it("should allow maps.googleapis.com", () => {
        const result = validateUrlForSSRF("https://maps.googleapis.com/maps/api/geocode/json");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow www.googleapis.com", () => {
        const result = validateUrlForSSRF("https://www.googleapis.com/geolocation/v1/geolocate");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow www.google-analytics.com", () => {
        const result = validateUrlForSSRF("https://www.google-analytics.com/collect");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow analytics.google.com", () => {
        const result = validateUrlForSSRF("https://analytics.google.com/analytics/web");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow HTTP protocol (not just HTTPS)", () => {
        const result = validateUrlForSSRF("http://maps.googleapis.com/maps/api/geocode/json");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow URLs with query parameters", () => {
        const result = validateUrlForSSRF("https://maps.googleapis.com/maps/api/geocode/json?address=test&key=abc123");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow URLs with paths", () => {
        const result = validateUrlForSSRF("https://www.googleapis.com/geolocation/v1/geolocate");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow URLs with ports", () => {
        const result = validateUrlForSSRF("https://maps.googleapis.com:443/maps/api/geocode/json");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe("invalid URLs - non-allowed domains", () => {
      it("should reject arbitrary external domains", () => {
        const result = validateUrlForSSRF("https://evil.com/steal-data");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("not in the allowed whitelist");
      });

      it("should reject subdomains of non-allowed domains", () => {
        const result = validateUrlForSSRF("https://api.evil.com/data");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("not in the allowed whitelist");
      });

      it("should reject domains that look similar but are different", () => {
        const result = validateUrlForSSRF("https://maps-googleapis.com/fake");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("not in the allowed whitelist");
      });

      it("should reject domains with typosquatting attempts", () => {
        const result = validateUrlForSSRF("https://maps.goog1eapis.com/fake");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("not in the allowed whitelist");
      });
    });

    describe("private/internal IP addresses", () => {
      it("should reject 10.x.x.x (private IPv4)", () => {
        const result = validateUrlForSSRF("http://10.0.0.1/internal-api");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject 192.168.x.x (private IPv4)", () => {
        const result = validateUrlForSSRF("http://192.168.1.1/admin");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject 172.16-31.x.x (private IPv4)", () => {
        const result = validateUrlForSSRF("http://172.16.0.1/internal");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject 127.x.x.x (localhost IPv4)", () => {
        const result = validateUrlForSSRF("http://127.0.0.1/localhost");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject 169.254.x.x (link-local IPv4)", () => {
        const result = validateUrlForSSRF("http://169.254.1.1/test");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject ::1 (localhost IPv6)", () => {
        const result = validateUrlForSSRF("http://[::1]/test");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject fc00:: (private IPv6)", () => {
        const result = validateUrlForSSRF("http://[fc00::1]/test");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject fe80:: (link-local IPv6)", () => {
        const result = validateUrlForSSRF("http://[fe80::1]/test");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Private/internal IP addresses are not allowed");
      });

      it("should reject public IP addresses (must be explicitly whitelisted)", () => {
        const result = validateUrlForSSRF("http://8.8.8.8/dns");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("IP addresses must be explicitly whitelisted");
      });

      it("should reject IPv6 addresses (must be explicitly whitelisted)", () => {
        const result = validateUrlForSSRF("http://[2001:4860:4860::8888]/dns");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("IP addresses must be explicitly whitelisted");
      });
    });

    describe("protocol validation", () => {
      it("should reject file:// protocol", () => {
        const result = validateUrlForSSRF("file:///etc/passwd");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Protocol file: is not allowed");
      });

      it("should reject ftp:// protocol", () => {
        const result = validateUrlForSSRF("ftp://example.com/file");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Protocol ftp: is not allowed");
      });

      it("should reject javascript: protocol", () => {
        const result = validateUrlForSSRF("javascript:alert('xss')");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Protocol javascript: is not allowed");
      });

      it("should reject data: protocol", () => {
        const result = validateUrlForSSRF("data:text/html,<script>alert('xss')</script>");
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Protocol data: is not allowed");
      });
    });

    describe("URL format validation", () => {
      it("should reject empty string", () => {
        const result = validateUrlForSSRF("");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("URL must be a non-empty string");
      });

      it("should reject whitespace-only string", () => {
        const result = validateUrlForSSRF("   ");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("URL must be a non-empty string");
      });

      it("should reject invalid URL format", () => {
        const result = validateUrlForSSRF("not-a-valid-url");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });

      it("should reject malformed URLs", () => {
        const result = validateUrlForSSRF("https://");
        expect(result.isValid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });
    });

    describe("custom allowed domains", () => {
      it("should allow custom domains when provided", () => {
        const customDomains = ["api.example.com", "cdn.example.com"];
        const result = validateUrlForSSRF("https://api.example.com/data", customDomains);
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should reject domains not in custom whitelist", () => {
        const customDomains = ["api.example.com"];
        const result = validateUrlForSSRF("https://evil.com/data", customDomains);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("not in the allowed whitelist");
      });

      it("should use default domains when null is passed", () => {
        const result = validateUrlForSSRF("https://maps.googleapis.com/api", null);
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow subdomains when base domain is whitelisted", () => {
        const customDomains = ["ananda.org"];
        // Should allow www.ananda.org when ananda.org is whitelisted
        const result = validateUrlForSSRF("https://www.ananda.org/data", customDomains);
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should allow multiple subdomains when base domain is whitelisted", () => {
        const customDomains = ["example.com"];
        const testCases = [
          "https://www.example.com/data",
          "https://api.example.com/data",
          "https://cdn.example.com/data",
          "https://sub.api.example.com/data",
        ];
        testCases.forEach((url) => {
          const result = validateUrlForSSRF(url, customDomains);
          expect(result.isValid).toBe(true);
        });
      });

      it("should not allow domains that just end with the whitelisted domain", () => {
        const customDomains = ["example.com"];
        // Should NOT allow evil-example.com (not a subdomain)
        const result = validateUrlForSSRF("https://evil-example.com/data", customDomains);
        expect(result.isValid).toBe(false);
        expect(result.error).toContain("not in the allowed whitelist");
      });
    });

    describe("environment variable configuration", () => {
      it("should include domains from SSRF_ALLOWED_DOMAINS env var", () => {
        process.env.SSRF_ALLOWED_DOMAINS = "api.example.com,cdn.example.com";
        const result = validateUrlForSSRF("https://api.example.com/data");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should handle spaces in env var domain list", () => {
        process.env.SSRF_ALLOWED_DOMAINS = "api.example.com, cdn.example.com";
        const result = validateUrlForSSRF("https://cdn.example.com/data");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should filter out empty domains from env var", () => {
        process.env.SSRF_ALLOWED_DOMAINS = "api.example.com,,cdn.example.com";
        const result = validateUrlForSSRF("https://api.example.com/data");
        expect(result.isValid).toBe(true);
      });

      it("should combine env domains with base domains", () => {
        process.env.SSRF_ALLOWED_DOMAINS = "api.example.com";
        // Should still allow base domains
        const result1 = validateUrlForSSRF("https://maps.googleapis.com/api");
        expect(result1.isValid).toBe(true);
        // Should also allow env domains
        const result2 = validateUrlForSSRF("https://api.example.com/data");
        expect(result2.isValid).toBe(true);
      });
    });

    describe("case insensitivity", () => {
      it("should handle uppercase domains", () => {
        const result = validateUrlForSSRF("https://MAPS.GOOGLEAPIS.COM/api");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it("should handle mixed case domains", () => {
        const result = validateUrlForSSRF("https://Maps.GoogleAPIs.com/api");
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    describe("wildcard subdomain support", () => {
      it("should support wildcard subdomains", () => {
        const customDomains = ["*.example.com"];
        const result1 = validateUrlForSSRF("https://api.example.com/data", customDomains);
        expect(result1.isValid).toBe(true);

        const result2 = validateUrlForSSRF("https://cdn.example.com/data", customDomains);
        expect(result2.isValid).toBe(true);

        const result3 = validateUrlForSSRF("https://sub.api.example.com/data", customDomains);
        expect(result3.isValid).toBe(true);
      });

      it("should allow exact domain match with wildcard", () => {
        const customDomains = ["*.example.com"];
        const result = validateUrlForSSRF("https://example.com/data", customDomains);
        expect(result.isValid).toBe(true);
      });

      it("should reject domains not matching wildcard", () => {
        const customDomains = ["*.example.com"];
        const result = validateUrlForSSRF("https://evil.com/data", customDomains);
        expect(result.isValid).toBe(false);
      });
    });
  });

  describe("safeFetch", () => {
    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });

    it("should call fetch for valid URLs", async () => {
      await safeFetch("https://maps.googleapis.com/api");
      expect(global.fetch).toHaveBeenCalledWith("https://maps.googleapis.com/api", undefined);
    });

    it("should pass fetch options correctly", async () => {
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "data" }),
      };
      await safeFetch("https://maps.googleapis.com/api", options);
      expect(global.fetch).toHaveBeenCalledWith("https://maps.googleapis.com/api", options);
    });

    it("should throw error for invalid URLs", async () => {
      await expect(safeFetch("https://evil.com/data")).rejects.toThrow("SSRF protection");
    });

    it("should throw error for private IP addresses", async () => {
      await expect(safeFetch("http://127.0.0.1/internal")).rejects.toThrow("SSRF protection");
    });

    it("should throw error with validation error message", async () => {
      await expect(safeFetch("https://evil.com/data")).rejects.toThrow("not in the allowed whitelist");
    });

    it("should use custom allowed domains when provided", async () => {
      const customDomains = ["api.example.com"];
      await safeFetch("https://api.example.com/data", undefined, customDomains);
      expect(global.fetch).toHaveBeenCalledWith("https://api.example.com/data", undefined);
    });

    it("should reject URLs not in custom whitelist", async () => {
      const customDomains = ["api.example.com"];
      await expect(safeFetch("https://evil.com/data", undefined, customDomains)).rejects.toThrow("SSRF protection");
    });

    it("should handle fetch errors", async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error("Network error"));
      await expect(safeFetch("https://maps.googleapis.com/api")).rejects.toThrow("Network error");
    });
  });

  describe("sanitizeUrlForLogging", () => {
    it("should redact API key from query params", () => {
      const url = "https://maps.googleapis.com/api?address=test&key=secret123";
      const sanitized = sanitizeUrlForLogging(url);
      // URL encoding encodes brackets, so check for encoded version
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).not.toContain("secret123");
      expect(sanitized).toContain("key=");
    });

    it("should redact api_key from query params", () => {
      const url = "https://api.example.com/data?api_key=secret456";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("api_key=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).not.toContain("secret456");
    });

    it("should redact token from query params", () => {
      const url = "https://api.example.com/data?token=abc123xyz";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("token=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).not.toContain("abc123xyz");
    });

    it("should redact access_token from query params", () => {
      const url = "https://api.example.com/data?access_token=token123";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("access_token=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).not.toContain("token123");
    });

    it("should redact secret from query params", () => {
      const url = "https://api.example.com/data?secret=mysecret";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("secret=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).not.toContain("mysecret");
    });

    it("should redact multiple sensitive params", () => {
      const url = "https://api.example.com/data?key=key123&token=token456&secret=secret789";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("key=");
      expect(sanitized).toContain("token=");
      expect(sanitized).toContain("secret=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).not.toContain("key123");
      expect(sanitized).not.toContain("token456");
      expect(sanitized).not.toContain("secret789");
    });

    it("should preserve non-sensitive query params", () => {
      const url = "https://api.example.com/data?address=test&limit=10";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("address=test");
      expect(sanitized).toContain("limit=10");
    });

    it("should preserve URL structure", () => {
      const url = "https://maps.googleapis.com/maps/api/geocode/json?address=test&key=secret";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("https://maps.googleapis.com/maps/api/geocode/json");
      expect(sanitized).toContain("address=test");
    });

    it("should handle URLs without query params", () => {
      const url = "https://maps.googleapis.com/api";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toBe(url);
    });

    it("should handle invalid URLs gracefully", () => {
      const invalidUrl = "not-a-valid-url";
      const sanitized = sanitizeUrlForLogging(invalidUrl);
      expect(sanitized).toBe("[INVALID_URL]");
    });

    it("should handle malformed URLs", () => {
      const malformedUrl = "https://";
      const sanitized = sanitizeUrlForLogging(malformedUrl);
      expect(sanitized).toBe("[INVALID_URL]");
    });

    it("should handle URLs with hash fragments", () => {
      const url = "https://api.example.com/data?key=secret#section";
      const sanitized = sanitizeUrlForLogging(url);
      expect(sanitized).toContain("key=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).toContain("#section");
    });

    it("should handle URLs with ports", () => {
      const url = "https://api.example.com:443/data?key=secret";
      const sanitized = sanitizeUrlForLogging(url);
      // Note: URL constructor may normalize ports, so just check that key is redacted
      expect(sanitized).toContain("key=");
      expect(sanitized).toContain("%5BREDACTED%5D");
      expect(sanitized).toContain("api.example.com");
    });
  });

  describe("edge cases and security scenarios", () => {
    it("should prevent SSRF via localhost domain name", () => {
      // Even if someone tries to use "localhost" as a domain, IP validation should catch it
      // But first it will fail domain whitelist check
      const result = validateUrlForSSRF("http://localhost/internal");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("not in the allowed whitelist");
    });

    it("should prevent SSRF via 0.0.0.0", () => {
      const result = validateUrlForSSRF("http://0.0.0.0/internal");
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("IP addresses must be explicitly whitelisted");
    });

    it("should prevent SSRF via metadata service IPs", () => {
      // AWS metadata service
      const result = validateUrlForSSRF("http://169.254.169.254/latest/meta-data");
      expect(result.isValid).toBe(false);
      expect(result.error).toBe("Private/internal IP addresses are not allowed");
    });

    it("should handle URLs with encoded characters", () => {
      const result = validateUrlForSSRF("https://maps.googleapis.com/api?address=test%20city");
      expect(result.isValid).toBe(true);
    });

    it("should handle URLs with special characters in path", () => {
      const result = validateUrlForSSRF("https://maps.googleapis.com/api/v1/test-endpoint");
      expect(result.isValid).toBe(true);
    });
  });
});
