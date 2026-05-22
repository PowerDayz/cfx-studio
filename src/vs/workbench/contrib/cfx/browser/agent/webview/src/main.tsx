/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
	throw new Error('cfx-agent-webview: #root element missing in host HTML');
}
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
