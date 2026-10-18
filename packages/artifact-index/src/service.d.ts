import type { Server } from 'node:http';
import type { ArtifactIndex, Sharing } from './index.js';

export interface ArtifactMethodContract {
  description: string;
  parameters: Record<string, unknown>;
}
export const ARTIFACT_METHODS: Record<'artifacts.search' | 'artifacts.read' | 'artifacts.list' | 'artifacts.status', ArtifactMethodContract>;
export interface ArtifactServiceOptions {
  index: Pick<ArtifactIndex, 'search' | 'read' | 'list' | 'stats'>;
  /** Loopback DreamMate gateway origin. */
  agent?: string;
  /** Loopback listener port. A zero port requests an ephemeral test port. */
  port?: number;
  sharing?: Sharing;
  register?: boolean;
  serviceId?: string;
  log?: (message: string) => void;
  registrationIntervalMs?: number;
}
export interface ArtifactServiceHealth {
  status: 'ok'; service: 'artifact-index'; protocol: string; pid: number; sharing: Sharing; read_only: true;
  registration: {registered: boolean; local_confirmed: boolean; last_error?: string};
}
export interface ArtifactServiceDescriptor {
  id: string; name: string; kind: 'generic'; port: number; sharing: Sharing;
  reachability: 'localhost'; execution: 'http'; health: '/health'; methods: typeof ARTIFACT_METHODS;
  resources: Array<{scheme: 'artifact'; description: string}>;
  metadata: {artifact_index_provider: {protocol: string; version: string; instance_id: string; read_only: true}; invoke_timeout_ms: number};
}
export interface ArtifactService {
  server: Server;
  health(): ArtifactServiceHealth;
  descriptor(): ArtifactServiceDescriptor;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}
/** Register a separately owned, read-only service. It never scans or changes source files. */
export function serveArtifactIndex(options: ArtifactServiceOptions): Promise<ArtifactService>;
