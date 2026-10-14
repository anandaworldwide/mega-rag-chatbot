// __mocks__/next/server.js

// Mock implementation for NextRequest and NextResponse used by Edge Runtime

function createNextUrl(url) {
  const parsed = new URL(url);
  parsed.clone = function clone() {
    return createNextUrl(this.href);
  };
  return parsed;
}

class MockHeaders {
  constructor(init) {
    this.headers = {};
    if (!init) {
      return;
    }
    if (typeof init.forEach === "function") {
      init.forEach((value, key) => {
        this.headers[String(key).toLowerCase()] = value;
      });
      return;
    }
    Object.entries(init).forEach(([key, value]) => {
      this.headers[key.toLowerCase()] = value;
    });
  }
  get(name) {
    return this.headers[name.toLowerCase()] || null;
  }
  set(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  has(name) {
    return name.toLowerCase() in this.headers;
  }
  append(name, value) {
    const lowerName = name.toLowerCase();
    if (this.headers[lowerName]) {
      this.headers[lowerName] += `, ${value}`;
    } else {
      this.headers[lowerName] = value;
    }
  }
  delete(name) {
    delete this.headers[name.toLowerCase()];
  }
  forEach(callback) {
    Object.entries(this.headers).forEach(([key, value]) =>
      callback(value, key, this),
    );
  }
  entries() {
    return Object.entries(this.headers);
  }
  keys() {
    return Object.keys(this.headers);
  }
  values() {
    return Object.values(this.headers);
  }
  [Symbol.iterator]() {
    return this.entries()[Symbol.iterator]();
  }
}

class MockNextRequest {
  constructor(input, init) {
    this.url = typeof input === "string" ? input : input.url;
    this.method = init?.method || "GET";
    this.headers = new MockHeaders(init?.headers);
    this.geo = init?.geo || {};
    this.ip = init?.ip || "";
    this.nextUrl = createNextUrl(this.url);
    this.cookies = {
      get: (name) => {
        const raw = this.headers.get("cookie") || "";
        const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
        return match ? { name, value: decodeURIComponent(match[1]) } : undefined;
      },
    };
  }

  json() {
    return Promise.resolve({});
  }

  text() {
    return Promise.resolve('');
  }

  // Add other methods as needed
}

class MockNextResponse {
  constructor(body, init) {
    this.body = body;
    this.status = init?.status || 200;
    this.statusText = init?.statusText || '';
    this.headers = new MockHeaders(init?.headers);
    this.bodyUsed = false; // Track body usage
  }

  // Instance methods to mimic Response API
  async json() {
    if (this.bodyUsed) {
      throw new TypeError('Already read');
    }
    this.bodyUsed = true;
    try {
      return JSON.parse(this.body);
    } catch (_e) {
      throw new SyntaxError('Invalid JSON');
    }
  }

  async text() {
    if (this.bodyUsed) {
      throw new TypeError('Already read');
    }
    this.bodyUsed = true;
    return String(this.body);
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  clone() {
    // Basic clone, may need enhancement depending on usage
    const cloned = new MockNextResponse(this.body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers.headers,
    });
    return cloned;
  }

  static json(data, init) {
    const headers = new MockHeaders(init?.headers);
    headers.set("content-type", "application/json");
    return new MockNextResponse(JSON.stringify(data), { ...init, headers });
  }

  static next(init) {
    const res = new MockNextResponse(null, { status: 200 });
    const requestHeaders = init?.request?.headers;
    if (requestHeaders && typeof requestHeaders.forEach === "function") {
      const overridden = [];
      requestHeaders.forEach((value, key) => {
        res.headers.set(`x-middleware-request-${key}`, value);
        overridden.push(key);
      });
      res.headers.set("x-middleware-override-headers", overridden.join(","));
    }
    return res;
  }

  static redirect(url, statusOrInit) {
    const status = typeof statusOrInit === "number" ? statusOrInit : statusOrInit?.status || 307;
    const res = new MockNextResponse(null, { status });
    res.headers.set("location", String(url));
    return res;
  }
}

module.exports = {
  NextRequest: MockNextRequest,
  NextResponse: MockNextResponse,
  Headers: MockHeaders,
};
