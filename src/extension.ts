/**********************************************************************
 * Copyright (C) 2025 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import { existsSync } from 'node:fs';

import * as macadamJSPackage from '@crc-org/macadam.js';
import * as extensionApi from '@podman-desktop/api';

import { initAuthentication } from './authentication';
import { ImageCache } from './cache';
import { MACADAM_IMAGE_PROPERTY_KEY, MACADAM_IMAGE_PROPERTY_VALUE_LOCAL, MACADAM_LOCAL_IMAGE_KEY } from './constants';
import { getImageSha } from './images';
import { LoggerDelegator } from './logger';
import { ProviderConnectionShellAccessImpl } from './macadam-machine-stream';
import { getErrorMessage, pullImageFromRedHatRegistry, verifyContainerProivder } from './utils';
import { isHyperVEnabled, isWSLEnabled } from './win/utils';

const MACADAM_CLI_NAME = 'macadam';
const MACADAM_CLI_DISPLAY_NAME = 'Macadam';
const MACADAM_CLI_MARKDOWN = `macadam CLI can help you run RHEL and other linux-based VMs`;
const EXTENSION_DESCRIPTION_MARKDOWN = `Podman Desktop can help you run Red Hat Enterprise Linux and other Linux-based virtual machines`;

let stopLoop = false;

type StatusHandler = (name: string, event: extensionApi.ProviderConnectionStatus) => void;
const macadamMachinesInfo = new Map<string, MachineInfo>();
const currentConnections = new Map<string, extensionApi.Disposable>();

let wslAndHypervEnabledContextValue = false;
const WSL_HYPERV_ENABLED_KEY = 'macadam.wslHypervEnabled';

const listeners = new Set<StatusHandler>();

export interface BinaryInfo {
  path: string;
  version: string;
  installationSource: 'extension' | 'external';
}

export type MachineInfo = {
  name: string;
  image: string;
  cpus: number;
  memory: number;
  diskSize: number;
  port: number;
  remoteUsername: string;
  identityPath: string;
  vmType: string;
};

type MachineJSON = {
  Name: string;
  Image: string;
  CPUs: number;
  Memory: string;
  DiskSize: string;
  Running: boolean;
  Starting: boolean;
  Port: number;
  RemoteUsername: string;
  IdentityPath: string;
  VMType: string;
};

type MachineJSONListOutput = {
  list: MachineJSON[];
  error: string;
};

export let macadam: macadamJSPackage.Macadam;

export const macadamMachinesStatuses = new Map<string, extensionApi.ProviderConnectionStatus>();

export async function activate(extensionContext: extensionApi.ExtensionContext): Promise<void> {
  macadam = new macadamJSPackage.Macadam('rhel');
  await macadam.init();

  const provider = await createProvider(extensionContext);

  monitorMachines(provider, extensionContext).catch((error: unknown) => {
    console.error('Error while monitoring machines', error);
  });

  // create cli tool for the cliTool page in desktop
  const macadamCli = extensionApi.cli.createCliTool({
    name: MACADAM_CLI_NAME,
    images: {
      icon: './icon.png',
    },
    displayName: MACADAM_CLI_DISPLAY_NAME,
    markdownDescription: MACADAM_CLI_MARKDOWN,
  });

  extensionContext.subscriptions.push(macadamCli);
}

async function timeout(time: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, time);
  });
}

async function getJSONMachineList(): Promise<MachineJSONListOutput> {
  const vmProviders: (string | undefined)[] = [];

  if (extensionApi.env.isWindows) {
    let hypervEnabled = false;
    let wslEnabled = false;
    if (await isWSLEnabled()) {
      wslEnabled = true;
      vmProviders.push('wsl');
    }

    if (await isHyperVEnabled()) {
      hypervEnabled = true;
      vmProviders.push('hyperv');
    }
    // update context "wsl-hyperv enabled" value
    updateWSLHyperVEnabledContextValue(wslEnabled && hypervEnabled);
  }

  if (extensionApi.env.isMac) {
    vmProviders.push('applehv');
  }

  if (vmProviders.length === 0) {
    // in all other cases we set undefined so that it executes normally by using the default vm provider
    vmProviders.push(undefined);
  }

  const list: MachineJSON[] = [];
  let error = '';

  try {
    for (const provider of vmProviders) {
      const machineListOutput = await getJSONMachineListByProvider(provider);
      list.push(...machineListOutput.list);
      if (machineListOutput.error && machineListOutput.error.trim() !== '') {
        error += machineListOutput.error + '\n';
      }
    }
  } catch (err) {
    error = getErrorMessage(err);
  }

  return { list, error };
}

export async function getJSONMachineListByProvider(vmProvider?: string): Promise<MachineJSONListOutput> {
  let stdout: macadamJSPackage.VmDetails[] = [];
  let stderr = '';
  try {
    stdout = await macadam.listVms({ containerProvider: verifyContainerProivder(vmProvider ?? '') });
  } catch (err: unknown) {
    stderr = `${err}`;
  }
  return {
    list: stdout,
    error: stderr,
  };
}

async function startMachine(
  provider: extensionApi.Provider,
  machineInfo: MachineInfo,
  context?: extensionApi.LifecycleContext,
  logger?: extensionApi.Logger,
): Promise<void> {
  const telemetryRecords: Record<string, unknown> = {};
  telemetryRecords.provider = 'macadam';
  const startTime = performance.now();

  try {
    await macadam.startVm({
      name: machineInfo.name,
      containerProvider: verifyContainerProivder(machineInfo.vmType),
      runOptions: { logger: new LoggerDelegator(context, logger) },
    });
    provider.updateStatus('started');
  } catch (err) {
    telemetryRecords.error = err;
    console.error(err);
    throw err;
  } finally {
    // send telemetry event
    const endTime = performance.now();
    telemetryRecords.duration = endTime - startTime;
    //in the POC we do not send any telemetry
    // sendTelemetryRecords('macadam.machine.start', telemetryRecords, true);
  }
}

async function stopMachine(
  provider: extensionApi.Provider,
  machineInfo: MachineInfo,
  context?: extensionApi.LifecycleContext,
  logger?: extensionApi.Logger,
): Promise<void> {
  const startTime = performance.now();
  const telemetryRecords: Record<string, unknown> = {};
  telemetryRecords.provider = 'macadam';
  try {
    await macadam.stopVm({
      name: machineInfo.name,
      containerProvider: verifyContainerProivder(machineInfo.vmType),
      runOptions: { logger: new LoggerDelegator(context, logger) },
    });
    provider.updateStatus('stopped');
  } catch (err: unknown) {
    telemetryRecords.error = err;
    throw err;
  } finally {
    // send telemetry event
    const endTime = performance.now();
    telemetryRecords.duration = endTime - startTime;
    //in the POC we do not send any telemetry
    //sendTelemetryRecords('macadam.machine.stop', telemetryRecords, false);
  }
}

async function registerProviderFor(
  provider: extensionApi.Provider,
  machineInfo: MachineInfo,
  context: extensionApi.ExtensionContext,
): Promise<void> {
  const lifecycle: extensionApi.ProviderConnectionLifecycle = {
    start: async (context, logger): Promise<void> => {
      await startMachine(provider, machineInfo, context, logger);
    },
    stop: async (context, logger): Promise<void> => {
      await stopMachine(provider, machineInfo, context, logger);
    },
    delete: async (logger): Promise<void> => {
      await macadam.removeVm({
        name: machineInfo.name,
        containerProvider: verifyContainerProivder(machineInfo.vmType),
        runOptions: { logger },
      });
    },
  };

  const providerConnectionShellAccess = new ProviderConnectionShellAccessImpl(machineInfo);
  context.subscriptions.push(providerConnectionShellAccess);

  const vmProviderConnection: extensionApi.VmProviderConnection = {
    name: machineInfo.name,
    status: () => macadamMachinesStatuses.get(machineInfo.image) ?? 'unknown',
    shellAccess: providerConnectionShellAccess,
    lifecycle,
  };

  const disposable = provider.registerVmProviderConnection(vmProviderConnection);
  provider.updateStatus('ready');

  // get configuration for this connection
  const vmConfiguration = extensionApi.configuration.getConfiguration('macadam', vmProviderConnection);

  // Set values for the machine
  await vmConfiguration.update('machine.cpus', machineInfo.cpus);
  await vmConfiguration.update('machine.memory', machineInfo.memory);
  await vmConfiguration.update('machine.diskSize', machineInfo.diskSize);

  currentConnections.set(machineInfo.image, disposable);
}

async function updateMachines(provider: extensionApi.Provider, context: extensionApi.ExtensionContext): Promise<void> {
  // init machines available
  const machineListOutput = await getJSONMachineList();

  if (machineListOutput.error) {
    // TODO handle the error
    console.error(machineListOutput.error);
  }

  // parse output
  const machines = machineListOutput.list;

  // update status of existing machines - in the POC only one can exist, just to keep code that can be reused in future
  for (const machine of machines) {
    const running = machine?.Running === true;
    let status: extensionApi.ProviderConnectionStatus = running ? 'started' : 'stopped';

    // update the status to starting if the machine is running but still starting
    const starting = machine?.Starting === true;
    if (starting) {
      status = 'starting';
    }

    const previousStatus = macadamMachinesStatuses.get(machine.Image);
    if (previousStatus !== status) {
      // notify status change
      listeners.forEach(listener => listener(machine.Image, status));
      macadamMachinesStatuses.set(machine.Image, status);
    }

    // TODO update cpu/memory/disk usage

    macadamMachinesInfo.set(machine.Image, {
      name: machine.Name,
      image: machine.Image,
      memory: Number(machine.Memory),
      cpus: Number(machine.CPUs),
      diskSize: Number(machine.DiskSize),
      port: machine.Port,
      remoteUsername: machine.RemoteUsername,
      identityPath: machine.IdentityPath,
      vmType: machine.VMType,
    });

    if (!macadamMachinesStatuses.has(machine.Image)) {
      macadamMachinesStatuses.set(machine.Image, status);
    }
  }

  // remove machine no longer there
  const machinesToRemove = Array.from(macadamMachinesStatuses.keys()).filter(
    machine => !machines.find(m => m.Image === machine),
  );
  machinesToRemove.forEach(machine => {
    macadamMachinesStatuses.delete(machine);
  });

  // create connections for new machines
  const connectionsToCreate = Array.from(macadamMachinesStatuses.keys()).filter(
    machineStatusKey => !currentConnections.has(machineStatusKey),
  );
  await Promise.all(
    connectionsToCreate.map(async machineName => {
      const podmanMachineInfo = macadamMachinesInfo.get(machineName);
      if (podmanMachineInfo) {
        await registerProviderFor(provider, podmanMachineInfo, context);
      }
    }),
  );

  // delete connections for machines no longer there
  machinesToRemove.forEach(machine => {
    const disposable = currentConnections.get(machine);
    if (disposable) {
      disposable.dispose();
      currentConnections.delete(machine);
    }
  });

  // If the machine length is zero and we are on macOS or Windows,
  // we will update the provider as being 'installed', or ready / starting / configured if there is a machine
  // if we are on Linux, ignore this as podman machine is OPTIONAL and the provider status in Linux is based upon
  // the native podman installation / not machine.
  if (!extensionApi.env.isLinux) {
    if (machines.length === 0) {
      if (provider.status !== 'configuring') {
        provider.updateStatus('installed');
      }
    } else {
      /*
       * The machine can have 3 states, based on `Starting` and `Running` fields:
       * - !Running && !Starting -> configured
       * -  Running &&  Starting -> starting
       * -  Running && !Starting -> ready
       */
      const atLeastOneMachineRunning = machines.some(machine => machine.Running && !machine.Starting);
      const atLeastOneMachineStarting = machines.some(machine => machine.Starting);
      // if a machine is running it's started else it is ready
      if (atLeastOneMachineRunning) {
        provider.updateStatus('ready');
      } else if (atLeastOneMachineStarting) {
        // update to starting
        provider.updateStatus('starting');
      } else {
        // needs to start a machine
        provider.updateStatus('configured');
      }

      // Finally, we check to see if the machine that is running is set by default or not on the CLI
      // this will create a dialog that will ask the user if they wish to set the running machine as default.
      // this should only run if we at least one machine
      //await checkDefaultMachine(machines);
    }
  }
}

async function monitorMachines(provider: extensionApi.Provider, context: extensionApi.ExtensionContext): Promise<void> {
  // call us again
  if (!stopLoop) {
    try {
      await updateMachines(provider, context);
    } catch (error) {
      // ignore the update of machines
    }
    await timeout(5000);
    monitorMachines(provider, context).catch((error: unknown) => {
      console.error('Error monitoring podman machines', error);
    });
  }
}

async function createProvider(extensionContext: extensionApi.ExtensionContext): Promise<extensionApi.Provider> {
  const imageCache = new ImageCache(extensionContext.storagePath);
  await imageCache.init();

  const providerOptions: extensionApi.ProviderOptions = {
    name: 'RHEL VMs',
    id: 'macadam',
    status: 'unknown',
    images: {
      icon: './icon.png',
      logo: {
        dark: './icon.png',
        light: './icon.png',
      },
    },
    emptyConnectionMarkdownDescription: EXTENSION_DESCRIPTION_MARKDOWN,
  };

  const provider = extensionApi.provider.createProvider(providerOptions);

  extensionContext.subscriptions.push(provider);

  // enable factory
  provider.setVmProviderConnectionFactory(
    {
      create: (
        params: { [key: string]: unknown },
        logger?: extensionApi.Logger,
        token?: extensionApi.CancellationToken,
      ) => {
        return createVM(imageCache, params, logger, token);
      },
      creationDisplayName: 'Virtual machine',
    },
    {
      auditItems,
    },
  );

  return provider;
}

async function createVM(
  imageCache: ImageCache,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: { [key: string]: any },
  logger?: extensionApi.Logger,
  token?: extensionApi.CancellationToken,
): Promise<void> {
  const telemetryRecords: Record<string, unknown> = {};
  if (extensionApi.env.isMac) {
    telemetryRecords.OS = 'mac';
  } else if (extensionApi.env.isWindows) {
    telemetryRecords.OS = 'win';
  }

  let provider: 'wsl' | 'hyperv' | 'applehv' | undefined;
  if (params['macadam.factory.machine.win.provider']) {
    provider = params['macadam.factory.machine.win.provider'];
    telemetryRecords.provider = provider;
  } else {
    if (extensionApi.env.isWindows) {
      provider = (await isWSLEnabled()) ? 'wsl' : 'hyperv';
      telemetryRecords.provider = provider;
    } else if (extensionApi.env.isMac) {
      provider = 'applehv';
      telemetryRecords.provider = provider;
    }
  }

  // name
  const name = params['macadam.factory.machine.name'];

  // image
  const imageValue = params[MACADAM_IMAGE_PROPERTY_KEY];
  if (imageValue && typeof imageValue !== 'string') {
    throw new Error('image must be a string');
  }
  const image = imageValue === MACADAM_IMAGE_PROPERTY_VALUE_LOCAL ? undefined : imageValue;

  // image-path
  let imagePath = params['macadam.factory.machine.image-path'];
  if (imagePath) {
    telemetryRecords.imagePath = 'custom';
  }

  if (image) {
    const cachedImagePath = imageCache.getPath(image);
    if (existsSync(cachedImagePath)) {
      imagePath = cachedImagePath;
      telemetryRecords.imagePath = 'cached';
      logger?.log(`Using image cached in ${cachedImagePath}\n`);
    } else {
      const client = await initAuthentication();
      const imageSha = getImageSha(provider);
      logger?.log('Downloading image, please wait...\n');
      await pullImageFromRedHatRegistry(client, imageSha, cachedImagePath, logger, token);
      logger?.log(`Image downloaded\n`);
      imagePath = cachedImagePath;
      telemetryRecords.imagePath = 'downloaded';
    }
  }

  const startTime = performance.now();
  try {
    logger?.log('Creating VM, please wait...\n');
    await macadam.createVm({
      name: name,
      imagePath: imagePath,
      username: 'core',
      containerProvider: provider,
      runOptions: { logger, token },
    });
  } catch (error) {
    telemetryRecords.error = error;
    const runError = error as extensionApi.RunError;

    let errorMessage = runError.name ? `${runError.name}\n` : '';
    errorMessage += runError.message ? `${runError.message}\n` : '';
    errorMessage += runError.stderr ? `${runError.stderr}\n` : '';
    throw errorMessage || error;
  } finally {
    const endTime = performance.now();
    telemetryRecords.duration = endTime - startTime;
    //in the POC we do not send any telemetry
    //sendTelemetryRecords('macadam.machine.init', telemetryRecords, false);
  }
}

function updateWSLHyperVEnabledContextValue(value: boolean): void {
  if (wslAndHypervEnabledContextValue !== value) {
    wslAndHypervEnabledContextValue = value;
    extensionApi.context.setValue(WSL_HYPERV_ENABLED_KEY, value);
  }
}

export function deactivate(): void {
  stopLoop = true;
  console.log('stopping macadam extension');
}

async function auditItems(items: extensionApi.AuditRequestItems): Promise<extensionApi.AuditResult> {
  const image = items[MACADAM_IMAGE_PROPERTY_KEY];
  extensionApi.context.setValue(MACADAM_LOCAL_IMAGE_KEY, image === MACADAM_IMAGE_PROPERTY_VALUE_LOCAL);
  return {
    records: [],
  };
}
