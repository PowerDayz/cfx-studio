/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('cfx-fxgraph-root');
if (root) {
	root.innerHTML = '';
	createRoot(root).render(<App />);
}
