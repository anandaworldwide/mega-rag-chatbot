/** @jest-environment node */

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreQueryGet: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn(() => "test_answers"),
}));

import { db } from "@/services/firebase";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { conversationBelongsToUuid } from "@/utils/server/conversationOwnershipUtils";

describe("conversationBelongsToUuid", () => {
  const mockLimit = jest.fn();
  const mockWhereUuid = jest.fn(() => ({ limit: mockLimit }));
  const mockWhereConvId = jest.fn(() => ({ where: mockWhereUuid }));
  const mockCollection = jest.fn(() => ({ where: mockWhereConvId }));

  beforeEach(() => {
    jest.clearAllMocks();
    (db!.collection as jest.Mock).mockImplementation(mockCollection);
    mockLimit.mockReturnValue("ownership-query");
  });

  it("returns true when a matching answers document exists", async () => {
    (firestoreQueryGet as jest.Mock).mockResolvedValueOnce({ empty: false });

    const result = await conversationBelongsToUuid("conv-123", "user-uuid");

    expect(result).toBe(true);
    expect(db!.collection).toHaveBeenCalledWith("test_answers");
    expect(mockWhereConvId).toHaveBeenCalledWith("convId", "==", "conv-123");
    expect(mockWhereUuid).toHaveBeenCalledWith("uuid", "==", "user-uuid");
    expect(mockLimit).toHaveBeenCalledWith(1);
    expect(firestoreQueryGet).toHaveBeenCalledWith(
      "ownership-query",
      "verify conversation ownership",
      "convId: conv-123, uuid: user-uuid"
    );
  });

  it("returns false when no matching answers document exists", async () => {
    (firestoreQueryGet as jest.Mock).mockResolvedValueOnce({ empty: true });

    const result = await conversationBelongsToUuid("conv-404", "user-uuid");

    expect(result).toBe(false);
  });
});
