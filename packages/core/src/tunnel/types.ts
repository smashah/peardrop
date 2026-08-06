import { z } from "zod";

export const TunnelDescriptorSchema = z.object({
  slug: z.string(),
  publicKey: z.string(),
  fingerprint: z.string(),
  relayUrls: z.array(z.string()),
  expiresAt: z.number(),
  pinRequired: z.boolean().default(false),
  maxSizeMB: z.number().optional(),
  expectedFiles: z.number().optional(),
  relayAllowed: z.boolean().default(true),
  label: z.string().optional(),
});

export type TunnelDescriptor = z.infer<typeof TunnelDescriptorSchema>;

export interface CreateTunnelOptions {
  publicKey: string;
  fingerprint: string;
  expectedFiles?: number;
  maxSizeMB?: number;
  ttlSeconds?: number;
  pin?: string;
  allowRelay?: boolean;
  relayCapGB?: number;
  label?: string;
}

export interface TunnelRecord extends TunnelDescriptor {
  createdAt: number;
  consumed: boolean;
  ownerTokenHash: string;
  pinHash?: string;
  relayAuth?: {
    scheme: "upto";
    maxAmountUsdc: string;
    signature?: string;
  };
  relayBytes: number;
  relayBytesBilled?: number;
}
