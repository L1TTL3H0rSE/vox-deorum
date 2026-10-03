/**
 * OpenTelemetry attributes describing host capabilities enabled for one model step.
 */

import type { Attributes } from '@opentelemetry/api';
import type { Model, ResolvedFilesConfig } from '../../types/config.js';
import { isHostCapabilityProvider, resolveHostToolCapabilities } from '../models/providers/host-tools.js';

/**
 * Return queryable host-capability attributes for one step. `host.capability` joins the enabled
 * capabilities with commas: `write` when any workspace mount is writable, otherwise `read` when
 * files are on (any provider), then `web` for a CLI provider with Web on.
 */
export function hostCapabilityTelemetryAttributes(model: Model, files?: ResolvedFilesConfig): Attributes {
  const capabilities: string[] = [];
  if (files) {
    const writable = files.game === 'write' || Object.values(files.shared).includes('write');
    capabilities.push(writable ? 'write' : 'read');
  }
  if (isHostCapabilityProvider(model.provider) && resolveHostToolCapabilities(model.options?.hostTools).web) {
    capabilities.push('web');
  }
  return capabilities.length > 0 ? { 'host.capability': capabilities.join(',') } : {};
}
