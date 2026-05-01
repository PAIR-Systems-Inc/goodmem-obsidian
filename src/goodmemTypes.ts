export interface CreateMemoryRequest {
  memoryId?: string;
  spaceId: string;
  originalContent?: string;
  contentType: string;
  metadata?: Record<string, any>;
}

export interface CreateMemoryResponse {
  memoryId: string;
  spaceId: string;
  processingStatus?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}

