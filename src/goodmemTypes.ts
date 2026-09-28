export interface CreateMemoryRequest {
  memoryId?: string;
  spaceId: string;
  originalContent?: string;
  contentType: string;
  metadata?: Record<string, any>;
}

export interface MemoryResponse {
  memoryId: string;
  spaceId: string;
  /** PENDING until GoodMem has chunked and embedded it, then COMPLETED or FAILED. */
  processingStatus?: string;
}

export interface CreateMemoryResponse {
  memoryId: string;
  spaceId: string;
  processingStatus?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}

