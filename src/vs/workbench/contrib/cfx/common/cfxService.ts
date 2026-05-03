/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Umbrella service for Cfx Studio. Currently a marker interface so feature
 * services (game mode, resources, FXServer, console, scaffolds, lua) can
 * declare their dependency on the Cfx contribution being initialized,
 * without each subsystem needing to know about every other.
 *
 * Concrete services live alongside their feature subdirectory.
 */
export interface ICfxService {
	readonly _serviceBrand: undefined;
}

export const ICfxService = createDecorator<ICfxService>('cfxService');
