import { NextRequest } from 'next/server';
import { NextApiRequest } from 'next';
import { isDevelopment } from '../env';

/**
 * Validates if a string is a valid IPv4 or IPv6 address
 */
function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') {
    return false;
  }

  // IPv4 regex: 0.0.0.0 to 255.255.255.255
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  
  // IPv6 regex: simplified check for valid IPv6 format
  // Matches compressed, uncompressed, and mixed IPv6 formats
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$|^::1$|^::$/;
  
  // Check for IPv4-mapped IPv6 addresses (::ffff:192.168.1.1)
  const ipv4MappedRegex = /^::ffff:(\d{1,3}\.){3}\d{1,3}$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || ipv4MappedRegex.test(ip);
}

/**
 * Extracts and validates the first valid IP from a comma-separated list
 * Handles proxy chaining by taking the leftmost (original client) IP
 */
function extractFirstValidIp(ipString: string): string | null {
  if (!ipString || typeof ipString !== 'string') {
    return null;
  }

  // Split by comma and trim each IP
  const ips = ipString.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0);
  
  // Return the first valid IP (leftmost in x-forwarded-for is the original client)
  for (const ip of ips) {
    if (isValidIp(ip)) {
      return ip;
    }
  }
  
  return null;
}

/**
 * Gets the client IP address from request headers, handling:
 * - IPv4 and IPv6 addresses
 * - Proxy scenarios (x-forwarded-for chaining)
 * - Cloudflare, Vercel, and other proxy headers
 * - Development environment
 */
export function getClientIp(req: NextApiRequest | NextRequest): string {
  // Special handling for development environment
  if (isDevelopment()) {
    return '127.0.0.1';
  }

  // Helper to get header value (works for both NextApiRequest and NextRequest)
  const getHeader = (name: string): string | string[] | null => {
    if (typeof req.headers.get === 'function') {
      // NextRequest
      const value = req.headers.get(name);
      return value ? value : null;
    } else {
      // NextApiRequest
      const headers = req.headers as Record<string, string | string[] | undefined>;
      return headers[name] || null;
    }
  };

  // Priority 1: Cloudflare-specific header (most reliable for Cloudflare proxies)
  const cfConnectingIp = getHeader('cf-connecting-ip');
  if (cfConnectingIp) {
    const ip = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    if (isValidIp(ip)) {
      return ip;
    }
  }

  // Priority 2: x-forwarded-for header (handles proxy chaining)
  // Format: "client, proxy1, proxy2" - we want the leftmost (original client)
  const forwardedFor = getHeader('x-forwarded-for');
  if (forwardedFor) {
    const ipString = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const validIp = extractFirstValidIp(ipString);
    if (validIp) {
      return validIp;
    }
  }

  // Priority 3: x-real-ip header (common in nginx and other proxies)
  const realIp = getHeader('x-real-ip');
  if (realIp) {
    const ip = Array.isArray(realIp) ? realIp[0] : realIp;
    if (isValidIp(ip)) {
      return ip;
    }
  }

  // Priority 4: x-client-ip header (some proxy configurations)
  const clientIp = getHeader('x-client-ip');
  if (clientIp) {
    const ip = Array.isArray(clientIp) ? clientIp[0] : clientIp;
    if (isValidIp(ip)) {
      return ip;
    }
  }

  // Priority 5: Direct connection IP (fallback for non-proxied requests)
  if ('socket' in req && req.socket) {
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress && isValidIp(remoteAddress)) {
      return remoteAddress;
    }
  }

  // If no valid IP found, return empty string (rate limiter will handle as "unknown")
  return '';
}
