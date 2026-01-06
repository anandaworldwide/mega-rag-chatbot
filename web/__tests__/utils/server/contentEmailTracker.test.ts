// Mock firebase-admin first before any imports
jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({
        seconds: 1234567890,
        nanoseconds: 0,
        toMillis: jest.fn(() => 1234567890000),
      })),
    },
  },
}));

// Mock @/services/firebase to prevent real Firebase initialization
jest.mock("@/services/firebase", () => ({
  db: {
    runTransaction: jest.fn(),
  },
}));

import { updateLastContentEmailSent } from "@/utils/server/contentEmailTracker";
import firebase from "firebase-admin";
import { db } from "@/services/firebase";

describe("contentEmailTracker", () => {
  let mockUserRef: firebase.firestore.DocumentReference;
  let mockTransaction: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockTransaction = {
      get: jest.fn(),
      update: jest.fn(),
    };

    mockUserRef = {
      id: "test@example.com",
    } as firebase.firestore.DocumentReference;

    // Mock the transaction to simulate successful execution
    (db!.runTransaction as jest.Mock).mockImplementation(async (callback) => {
      const docSnapshot = {
        exists: true,
        data: () => ({
          lastContentEmailSentAt: null, // No existing timestamp
        }),
      };
      mockTransaction.get.mockResolvedValue(docSnapshot);
      await callback(mockTransaction);
    });
  });

  it("should update lastContentEmailSentAt timestamp", async () => {
    await updateLastContentEmailSent(mockUserRef);

    expect((db as any).runTransaction).toHaveBeenCalledWith(expect.any(Function));
    expect(mockTransaction.get).toHaveBeenCalledWith(mockUserRef);
    expect(mockTransaction.update).toHaveBeenCalledWith(mockUserRef, {
      lastContentEmailSentAt: expect.objectContaining({ seconds: 1234567890 }),
    });
  });

  it("should silently skip if userRef is null", async () => {
    await updateLastContentEmailSent(null as any);

    expect((db as any).runTransaction).not.toHaveBeenCalled();
  });

  it("should silently skip if userRef is undefined", async () => {
    await updateLastContentEmailSent(undefined as any);

    expect((db as any).runTransaction).not.toHaveBeenCalled();
  });

  it("should handle errors gracefully without throwing", async () => {
    const mockError = new Error("Transaction error");
    jest.mocked(db!).runTransaction.mockRejectedValueOnce(mockError);

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(updateLastContentEmailSent(mockUserRef)).resolves.not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update lastContentEmailSentAt"),
      expect.any(String)
    );

    consoleSpy.mockRestore();
  });

  it("should use current timestamp", async () => {
    await updateLastContentEmailSent(mockUserRef);

    expect(firebase.firestore.Timestamp.now).toHaveBeenCalled();
    expect(mockTransaction.update).toHaveBeenCalledWith(mockUserRef, {
      lastContentEmailSentAt: expect.objectContaining({ seconds: 1234567890 }),
    });
  });

  it("should skip update if document doesn't exist", async () => {
    jest.mocked(db!).runTransaction.mockImplementation(async (callback: any) => {
      const docSnapshot = {
        exists: false,
        data: () => null,
      };
      mockTransaction.get.mockResolvedValue(docSnapshot);
      await callback(mockTransaction);
    });

    await updateLastContentEmailSent(mockUserRef);

    expect(mockTransaction.update).not.toHaveBeenCalled();
  });

  it("should skip update if new timestamp is older", async () => {
    jest.mocked(db! as any).runTransaction.mockImplementation(async (callback: any) => {
      const docSnapshot = {
        exists: true,
        data: () => ({
          lastContentEmailSentAt: {
            toMillis: () => Date.now() + 1000, // Future timestamp
          },
        }),
      };
      mockTransaction.get.mockResolvedValue(docSnapshot);
      await callback(mockTransaction);
    });

    await updateLastContentEmailSent(mockUserRef);

    expect(mockTransaction.update).not.toHaveBeenCalled();
  });
});
