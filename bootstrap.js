/* jshint -W041 */
/* globals APP_SHUTDOWN, ADDON_INSTALL, ADDON_UNINSTALL, Iterator */
/* globals Components, Services, XPCOMUtils */
const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/XPCOMUtils.jsm');

const XULNS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const XHTMLNS = 'http://www.w3.org/1999/xhtml';

const ADDON_ID = 'badge@darktrojan.net';

const BADGE_ANONID = 'badge';
const BADGE_SMALL_ANONID = 'badge-small';
const BADGE_LAYER_ANONID = 'badge-layer';

const STYLE_LARGE = 1;
const STYLE_SMALL = 2;

const MODE_BLACKLIST = 1;
const MODE_WHITELIST = 2;

const TITLE_REGEXP = /[\(\[]([0-9]{1,3})(\+?)( unread)?[\)\]]/;

const BROWSER_WINDOW = 'navigator:browser';
const PI_DATA = 'href="resource://tabbadge/badge.css" type="text/css"';
const IDLE_TIMEOUT = 15;

let aboutPage = {};
let autocomplete = {};
let prefs = Services.prefs.getBranch('extensions.tabbadge.');
let forecolor;
let backcolor;
let smallBadge;
let whitelistMode;
var blacklist, whitelist, alertlist, shakelist, soundlist;
let animating;
let removeDelay;
let obs;

let syncedPrefs = ['animating', 'blacklist', 'backcolor', 'forecolor', 'mode', 'removedelay', 'style', 'whitelist'];
let customRegExps = new Map();

/* globals strings, componentRegistrar */
XPCOMUtils.defineLazyGetter(this, 'strings', function() {
	return Services.strings.createBundle('chrome://tabbadge/locale/tabbadge.properties');
});
XPCOMUtils.defineLazyGetter(this, 'componentRegistrar', function() {
	return Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
});

/* globals alertsService, idleService */
XPCOMUtils.defineLazyServiceGetter(this, 'alertsService', '@mozilla.org/alerts-service;1', 'nsIAlertsService');
XPCOMUtils.defineLazyServiceGetter(this, 'idleService', '@mozilla.org/widget/idleservice;1', 'nsIIdleService');

/* exported install, uninstall, startup, shutdown */
function install() {
	if (prefs.getPrefType('donationreminder') == Ci.nsIPrefBranch.PREF_STRING) {
		prefs.clearUserPref('donationreminder');
	}
}
function uninstall(params, reason) {
	if (reason == ADDON_UNINSTALL) {
		Services.prefs.deleteBranch('extensions.tabbadge.');
		Services.prefs.deleteBranch('services.sync.prefs.sync.extensions.tabbadge.');
	}
}
function startup(params, reason) {
	let syncDefaultPrefs = Services.prefs.getDefaultBranch('services.sync.prefs.sync.extensions.tabbadge.');
	syncedPrefs.forEach(function(name) {
		syncDefaultPrefs.setBoolPref(name, false);
	});

	let defaultPrefs = Services.prefs.getDefaultBranch('extensions.tabbadge.');
	defaultPrefs.setCharPref('forecolor', '#FFFFFF');
	defaultPrefs.setCharPref('backcolor', '#CC0000');
	defaultPrefs.setIntPref('style', STYLE_LARGE);
	defaultPrefs.setIntPref('mode', MODE_BLACKLIST);
	defaultPrefs.setBoolPref('animating', true);
	defaultPrefs.setIntPref('removedelay', 0);
	defaultPrefs.setIntPref('donationreminder', 0);

	syncedPrefs.forEach(function(name) {
		syncDefaultPrefs.setBoolPref(name, true);
	});

	try {
		forecolor = prefs.getCharPref('forecolor');
		backcolor = prefs.getCharPref('backcolor');
		smallBadge = prefs.getIntPref('style') == STYLE_SMALL;
		whitelistMode = prefs.getIntPref('mode') == MODE_WHITELIST;
		animating = prefs.getBoolPref('animating');
		removeDelay = prefs.getIntPref('removedelay');

		blacklist = getArrayPref('blacklist');
		whitelist = getArrayPref('whitelist');
		alertlist = getArrayPref('alertlist');
		shakelist = getArrayPref('shakelist');
		soundlist = getArrayPref('soundlist');
	} catch (e) {
		Cu.reportError(strings.GetStringFromName('error.startup'));
		return;
	}
	readCustomPref();
	prefs.addObserver('', obs, false);

	let windowEnum = Services.wm.getEnumerator(BROWSER_WINDOW);
	while (windowEnum.hasMoreElements()) {
		paint(windowEnum.getNext());
	}
	Services.ww.registerNotification(obs);

	Services.obs.addObserver(obs, 'addon-options-displayed', false);
	Services.obs.addObserver(obs, 'tabbadge:playSound', false);

	if (reason != ADDON_INSTALL) {
		// Truncate version numbers to floats
		let oldVersion = parseFloat(prefs.getCharPref('version'), 10);
		let currentVersion = parseFloat(params.version, 10);
		let shouldRemind = true;

		if (prefs.getPrefType('donationreminder') == Ci.nsIPrefBranch.PREF_INT) {
			let lastReminder = prefs.getIntPref('donationreminder') * 1000;
			shouldRemind = Date.now() - lastReminder > 604800000;
		}

		if (shouldRemind && Services.vc.compare(oldVersion, currentVersion) == -1) {
			idleService.addIdleObserver(obs, IDLE_TIMEOUT);
		}
	}
	prefs.setCharPref('version', params.version);

	Services.scriptloader.loadSubScript(params.resourceURI.spec + 'components/about-tabbadge.js', aboutPage);
	componentRegistrar.registerFactory(
		aboutPage.TabBadgeAboutHandler.prototype.classID,
		'',
		aboutPage.TabBadgeAboutHandler.prototype.contractID,
		aboutPage.NSGetFactory(aboutPage.TabBadgeAboutHandler.prototype.classID)
	);

	Services.scriptloader.loadSubScript(params.resourceURI.spec + 'components/autocomplete.js', autocomplete);
	componentRegistrar.registerFactory(
		autocomplete.HostsAutoCompleteSearch.prototype.classID,
		'',
		autocomplete.HostsAutoCompleteSearch.prototype.contractID,
		autocomplete.NSGetFactory(autocomplete.HostsAutoCompleteSearch.prototype.classID)
	);
}
function shutdown(params, reason) {
	if (reason == APP_SHUTDOWN) {
		return;
	}

	Services.obs.removeObserver(obs, 'addon-options-displayed');
	Services.obs.removeObserver(obs, 'tabbadge:playSound', false);

	let windowEnum = Services.wm.getEnumerator(BROWSER_WINDOW);
	while (windowEnum.hasMoreElements()) {
		unpaint(windowEnum.getNext());
	}
	Services.ww.unregisterNotification(obs);

	prefs.removeObserver('', obs);

	try {
		idleService.removeIdleObserver(obs, IDLE_TIMEOUT);
	} catch (e) { // might be already removed
	}

	componentRegistrar.unregisterFactory(
		aboutPage.TabBadgeAboutHandler.prototype.classID,
		aboutPage.NSGetFactory(aboutPage.TabBadgeAboutHandler.prototype.classID)
	);

	componentRegistrar.unregisterFactory(
		autocomplete.HostsAutoCompleteSearch.prototype.classID,
		autocomplete.NSGetFactory(autocomplete.HostsAutoCompleteSearch.prototype.classID)
	);
}

function paint(win) {
	if (win.location == 'chrome://browser/content/browser.xul') {
		let document = win.document;
		let pi = document.createProcessingInstruction('xml-stylesheet', PI_DATA);
		document.insertBefore(pi, document.getElementById('main-window'));

		let tabContextMenu = document.getElementById('tabContextMenu');
		tabContextMenu.addEventListener('popupshowing', popupShowing, false);
		let sibling = document.getElementById('context_openTabInWindow').nextSibling;

		let menuSeparator = document.createElementNS(XULNS, 'menuseparator');
		menuSeparator.setAttribute('id', 'tabBadgeSeparator');
		tabContextMenu.insertBefore(menuSeparator, sibling);

		let menuItem = document.createElementNS(XULNS, 'menuitem');
		menuItem.setAttribute('id', 'tabBadgeBlacklist');
		menuItem.addEventListener('command', function() {
			let tab = document.popupNode;
			let uri = tab.linkedBrowser.currentURI;
			let list = whitelistMode ? whitelist : blacklist;
			let listName = whitelistMode ? 'whitelist' : 'blacklist';
			try {
				let blacklistString = uri.schemeIs('file') ? uri.spec : uri.host;
				let index = list.indexOf(blacklistString);
				if (index > -1) {
					list.splice(index, 1);
				} else {
					list.push(blacklistString);
				}
				Services.prefs.setCharPref('extensions.tabbadge.' + listName, list.join(' '));
			} catch (e) {
				logError(strings.formatStringFromName('error.' + listName, [uri.spec], 1));
			}
		}, false);
		tabContextMenu.insertBefore(menuItem, sibling);

		if (win.gMultiProcessBrowser) {
			win._tabBadgeListener = {
				receiveMessage: function(message) {
					let tab = win.gBrowser.getTabForBrowser(message.target);
					updateBadge(tab);
				}
			};

			win.messageManager.addMessageListener('DOMTitleChanged', win._tabBadgeListener);
		} else {
			let content = document.getElementById('content');
			content.addEventListener('DOMTitleChanged', titleChanged, false);
		}

		let tabbrowserTabs = document.getElementById('tabbrowser-tabs');
		tabbrowserTabs.addEventListener('TabMove', updateOnRearrange, false);
		tabbrowserTabs.addEventListener('TabAttrModified', fixBinding, false);
		tabbrowserTabs.addEventListener('TabPinned', fixBinding, false);
		tabbrowserTabs.addEventListener('TabUnpinned', fixBinding, false);
		enumerateWindowTabs(win, updateBadge);

		win.addEventListener('SSWindowStateReady', updateOnSessionRestore, false);
	}
}
function unpaint(win) {
	if (win.location == 'chrome://browser/content/browser.xul') {
		let document = win.document;

		if (win.gMultiProcessBrowser) {
			win.messageManager.removeMessageListener('DOMTitleChanged', win._tabBadgeListener);
			delete win._tabBadgeListener;
		} else {
			let content = document.getElementById('content');
			content.removeEventListener('DOMTitleChanged', titleChanged, false);
		}

		let tabbrowserTabs = document.getElementById('tabbrowser-tabs');
		tabbrowserTabs.removeEventListener('TabMove', updateOnRearrange, false);
		tabbrowserTabs.removeEventListener('TabAttrModified', fixBinding, false);
		tabbrowserTabs.removeEventListener('TabPinned', fixBinding, false);
		tabbrowserTabs.removeEventListener('TabUnpinned', fixBinding, false);
		enumerateWindowTabs(win, removeBadge);

		win.removeEventListener('SSWindowStateReady', updateOnSessionRestore, false);

		let tabContextMenu = document.getElementById('tabContextMenu');
		tabContextMenu.removeEventListener('popupshowing', popupShowing, false);

		let menuSeparator = document.getElementById('tabBadgeSeparator');
		if (menuSeparator)
			tabContextMenu.removeChild(menuSeparator);

		let menuItem = document.getElementById('tabBadgeBlacklist');
		if (menuItem)
			tabContextMenu.removeChild(menuItem);

		for (let i = 0; i < document.childNodes.length; i++) {
			let node = document.childNodes[i];
			if (node.nodeType == document.PROCESSING_INSTRUCTION_NODE && node.data == PI_DATA) {
				document.removeChild(node);
				break;
			}
		}
	}
}
obs = {
	observe: function(aSubject, aTopic, aData) {
		switch (aTopic) {
		case 'domwindowopened':
			aSubject.addEventListener('load', function() {
				paint(aSubject);
			}, false);
			break;
		case 'nsPref:changed':
			switch (aData) {
			case 'forecolor':
			case 'backcolor':
				forecolor = prefs.getCharPref('forecolor');
				backcolor = prefs.getCharPref('backcolor');
				enumerateTabs(function(tab) {
					if (smallBadge) {
						updateBadge(tab);
					} else {
						let tabBadge = tab.ownerDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_ANONID);
						if (tabBadge) {
							tabBadge.style.color = forecolor;
							tabBadge.style.backgroundColor = backcolor;
						}
					}
				});
				break;
			case 'blacklist':
				blacklist = getArrayPref('blacklist');
				if (!whitelistMode)
					enumerateTabs(updateBadge);
				break;
			case 'whitelist':
				whitelist = getArrayPref('whitelist');
				if (whitelistMode)
					enumerateTabs(updateBadge);
				break;
			case 'alertlist':
			case 'shakelist':
			case 'soundlist':
				Cu.getGlobalForObject(this)[aData] = getArrayPref(aData);
				break;
			case 'style':
				smallBadge = prefs.getIntPref('style') == STYLE_SMALL;
				enumerateTabs(updateBadge);
				break;
			case 'mode':
				whitelistMode = prefs.getIntPref('mode') == MODE_WHITELIST;
				enumerateTabs(updateBadge);
				break;
			case 'animating':
				animating = prefs.getBoolPref('animating');
				break;
			case 'removedelay':
				removeDelay = prefs.getIntPref('removedelay');
				break;
			case 'custom':
				readCustomPref();
				enumerateTabs(updateBadge);
				break;
			}
			break;
		case 'addon-options-displayed':
			function disableControl(aControl, aDisabled) {
				if (aDisabled) {
					aControl.setAttribute('disabled', 'true');
				} else {
					aControl.removeAttribute('disabled');
				}
			}

			if (aData == ADDON_ID) {
				let controls = {};
				for (let aName of ['style', 'mode']) {
					controls[aName] = aSubject.getElementById('tabbadge-' + aName).firstElementChild;
				}
				for (let aName of ['animating', 'blacklist', 'whitelist']) {
					controls[aName] = aSubject.getElementById('tabbadge-' + aName);
				}

				controls.style.addEventListener('command', function() {
					disableControl(controls.animating, controls.style.value != 1);
				});
				controls.mode.addEventListener('command', function() {
					disableControl(controls.blacklist, controls.mode.value != 1);
					disableControl(controls.whitelist, controls.mode.value != 2);
				});

				disableControl(controls.animating, controls.style.value != 1);
				disableControl(controls.blacklist, controls.mode.value != 1);
				disableControl(controls.whitelist, controls.mode.value != 2);
			}
			break;
		case 'idle':
			idleService.removeIdleObserver(this, IDLE_TIMEOUT);

			// Truncate version number to a float
			let version = parseFloat(prefs.getCharPref('version'), 10);
			let recentWindow = Services.wm.getMostRecentWindow(BROWSER_WINDOW);
			let browser = recentWindow.gBrowser;
			let notificationBox = recentWindow.document.getElementById('global-notificationbox');
			let message = strings.formatStringFromName('donate.message1', [version], 1);
			let label = strings.GetStringFromName('donate.button.label');
			let accessKey = strings.GetStringFromName('donate.button.accesskey');

			notificationBox.appendNotification(message, 'badge-donate', 'resource://tabbadge/icon16.png', notificationBox.PRIORITY_INFO_MEDIUM, [{
				label: label,
				accessKey: accessKey,
				callback: function() {
					browser.selectedTab = browser.addTab('https://addons.mozilla.org/addon/tab-badge/contribute/installed/');
				}
			}]);

			prefs.setIntPref('donationreminder', Date.now() / 1000);
			break;
		case 'tabbadge:playSound':
			let myrecentWindow = Services.wm.getMostRecentWindow(BROWSER_WINDOW);
			new myrecentWindow.Audio(getSoundFileURI()).play();
			break;
		}
	}
};

function getArrayPref(name) {
	let arr = [];
	if (prefs.prefHasUserValue(name)) {
		arr = prefs.getCharPref(name).split(/\s+/);
		for (let i = 0; i < arr.length; i++) {
			if (!arr[i]) {
				arr.splice(i, 1);
				i--;
			}
		}
	}
	return arr;
}

function readCustomPref() {
	customRegExps.clear();
	if (prefs.getPrefType('custom') != Ci.nsIPrefBranch.PREF_STRING) {
		return;
	}
	try {
		let obj = JSON.parse(prefs.getCharPref('custom'));
		for (let [k, v] of Iterator(obj)) {
			if (typeof v == 'string') {
				customRegExps.set(k, new RegExp(v));
			}
		}
	} catch (ex) {
		Cu.reportError(ex);
	}
}

function getSoundFileURI() {
	try {
		if (prefs.prefHasUserValue('soundfile')) {
			return Services.io.newFileURI(prefs.getComplexValue('soundfile', Ci.nsIFile)).spec;
		}
	} catch (ex) {
		logError(strings.GetStringFromName('error.soundfile'));
	}
	return 'resource://tabbadge/sound.ogg';
}

function popupShowing(event) {
	let document = event.target.ownerDocument;
	let menuSeparator = document.getElementById('tabBadgeSeparator');
	let menuItem = document.getElementById('tabBadgeBlacklist');

	let tab = document.popupNode;
	let uri = tab.linkedBrowser.currentURI;
	let label;

	try {
		let blacklisted = isBlacklisted(uri);
		if (whitelistMode) {
			label = blacklisted ? 'whitelist' : 'unwhitelist';
		} else {
			if (blacklisted) {
				label = 'unblacklist';
			} else {
				let tabBadge = tab.ownerDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_ANONID);
				let tabBadgeLayer = tab.ownerDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_LAYER_ANONID);
				if (!!tabBadge || !!tabBadgeLayer) {
					label = 'blacklist';
				}
			}
		}
		if (label) {
			if (uri.schemeIs('file')) {
				label = strings.GetStringFromName('domain.' + label + '.file');
			} else if (uri.host) {
				label = strings.formatStringFromName('domain.' + label, [uri.host], 1);
			} else {
				label = undefined;
			}
		}
	} catch (e) {
		label = undefined;
	}

	if (label) {
		menuSeparator.removeAttribute('collapsed');
		menuItem.removeAttribute('collapsed');
		menuItem.setAttribute('label', label);
	} else {
		menuSeparator.setAttribute('collapsed', 'true');
		menuItem.setAttribute('collapsed', 'true');
	}
}

function enumerateTabs(callback) {
	let windowEnum = Services.wm.getEnumerator(BROWSER_WINDOW);
	while (windowEnum.hasMoreElements()) {
		let window = windowEnum.getNext();
		enumerateWindowTabs(window, callback);
	}
}

function enumerateWindowTabs(window, callback) {
	let tabs = window.gBrowser.tabs;
	for (let i = 0; i < tabs.length; i++) {
		callback(tabs[i]);
	}
}

function titleChanged(event) {
	if (!event.isTrusted)
		return;

	let contentWin = event.target.defaultView;
	if (contentWin != contentWin.top)
		return;

	let tab = this._getTabForContentWindow(contentWin);
	if (tab) {
		contentWin.setTimeout(function() {
			updateBadge(tab);
		}, 100);
	}
}

function isInList(uri, list) {
	try {
		if (uri.schemeIs('file')) {
			return list.some(listItem => uri.spec.indexOf(listItem) == 0);
		} else {
			return list.indexOf(uri.host) >= 0;
		}
	} catch (ex) { // uri scheme might not have a host
		return false;
	}
}

function isBlacklisted(uri) {
	return whitelistMode != isInList(uri, whitelistMode ? whitelist : blacklist);
}

function updateBadge(tab) {
	let uri = tab.linkedBrowser.currentURI;
	if (isBlacklisted(uri)) {
		removeBadge(tab);
		return;
	}

	let match = TITLE_REGEXP.exec(tab.label);
	try {
		if (customRegExps.has(uri.host)) {
			match = customRegExps.get(uri.host).exec(tab.label);
		}
	} catch (ex) {
		// Call to uri.host might throw.
	}

	if (match) {
		tab.removeAttribute('titlechanged');
	}
	let badgeValue = match ? parseInt(match[1], 10) : 0;

	updateBadgeWithValue(tab, badgeValue, match);
}

function updateBadgeWithValue(tab, badgeValue, match) {
	let chromeDocument = tab.ownerDocument;
	let chromeWindow = chromeDocument.defaultView;

	if (!badgeValue) {
		if (!tab._badgeTimeout) {
			tab._badgeTimeout = chromeWindow.setTimeout(function() {
				removeBadge(tab);
				tab._badgeTimeout = null;
			}, removeDelay);
		}
		return;
	} else if (tab._badgeTimeout) {
		chromeWindow.clearTimeout(tab._badgeTimeout);
		tab._badgeTimeout = null;
	}

	let tabBrowserTabs = chromeDocument.getElementById('tabbrowser-tabs');
	let tabBadge = chromeDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_ANONID);
	let tabIcon = chromeDocument.getAnonymousElementByAttribute(tab, 'class', 'tab-icon-image');
	let tabBadgeLayer = chromeDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_LAYER_ANONID);
	let tabBadgeSmall = chromeDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_SMALL_ANONID);
	let oldValue = parseInt(tab.getAttribute('badgevalue'), 10) || 0;

	if (smallBadge) {
		removeBadge(tab, false, true);
		if (!tabBadgeLayer) {
			tabBadgeLayer = chromeDocument.createElementNS(XULNS, 'hbox');
			tabBadgeLayer.setAttribute('align', 'center');
			tabBadgeLayer.setAttribute('anonid', BADGE_LAYER_ANONID);
			tabBadgeLayer.setAttribute('class', 'tab-content');

			tabBadgeSmall = chromeDocument.createElementNS(XULNS, 'image');
			tabBadgeSmall.setAttribute('anonid', BADGE_SMALL_ANONID);
			tabBadgeSmall.setAttribute('class', 'tab-badge-small tab-icon-image');
			tabBadgeSmall.setAttribute('fadein', 'true');
			tabBadgeLayer.appendChild(tabBadgeSmall);
			chromeDocument.getAnonymousElementByAttribute(tab, 'class', 'tab-stack').appendChild(tabBadgeLayer);

			tabIcon.style.display = '-moz-box';
		}
		if (tab.hasAttribute('pinned')) {
			tabBadgeSmall.setAttribute('pinned', 'true');
		} else {
			tabBadgeSmall.removeAttribute('pinned');
		}
		tabBadgeSmall.setAttribute('src', drawNumber(tab.ownerDocument, badgeValue));

	} else {
		removeBadge(tab, true, false);
		if (match && match[2]) {
			badgeValue += '+';
		}
		if (tabBadge) {
			if (tabBadge.getAttribute('value') == badgeValue) {
				return;
			}
		} else {
			tabBadge = chromeDocument.createElementNS(XULNS, 'label');
			tabBadge.setAttribute('anonid', BADGE_ANONID);
			if (Services.vc.compare(Services.appinfo.version, 38) == -1) {
				tabBadge.setAttribute('fx37', 'true');
			}
			tabBadge.className = 'tab-badge tab-text';
			if (Services.appinfo.OS == 'WINNT') {
				tabBadge.classList.add('winstripe');
			}
			tabBadge.style.color = forecolor;
			tabBadge.style.backgroundColor = backcolor;
			tabBadge.style.animation = 'none';

			let closeButton = getCloseButton(tab);
			if (!closeButton) {
				Cu.reportError(strings.GetStringFromName('error.conflict'));
				return;
			}
			closeButton.parentNode.insertBefore(tabBadge, closeButton);

			chromeWindow.setTimeout(function() {
				tabBadge.style.borderBottomLeftRadius =
					tabBadge.style.borderBottomRightRadius =
					tabBadge.style.borderTopLeftRadius =
					tabBadge.style.borderTopRightRadius = Math.ceil(tabBadge.clientHeight / 2) + 'px';
				tabBadge.style.minWidth = tabBadge.clientHeight + 'px';
			}, 0);

			tabBadge.addEventListener('animationend', function() {
				tabBadge.style.animation = 'none';
			}, false);
		}

		tabBadge.setAttribute('value', badgeValue);

		if (tab.pinned) {
			tabBrowserTabs._positionPinnedTabs();
		}
	}

	tab.setAttribute('badgevalue', badgeValue);

	if (parseInt(badgeValue, 10) > oldValue) {
		if (!smallBadge && animating) {
			tabBadge.style.animation = null;
		}

		let uri = tab.linkedBrowser.currentURI;
		if (isInList(uri, shakelist)) {
			chromeWindow.getAttention();
		}
		if (isInList(uri, alertlist)) {
			alertsService.showAlertNotification('resource://tabbadge/icon64.png', tab.label, '', true, null, {
				observe: function(subject, topic) {
					if (topic == 'alertclickcallback') {
						chromeWindow.gBrowser.selectedTab = tab;
						chromeWindow.focus();
					}
				}
			});
		}
		if (isInList(uri, soundlist)) {
			new chromeWindow.Audio(getSoundFileURI()).play();
		}
	}
}

function removeBadge(tab, keepBadge, keepSmallBadge) {
	let document = tab.ownerDocument;
	if (!keepBadge) {
		let tabBadge = document.getAnonymousElementByAttribute(tab, 'anonid', BADGE_ANONID);
		if (tabBadge) {
			tabBadge.parentNode.removeChild(tabBadge);
			if (tab.pinned) {
				let tabBrowserTabs = document.getElementById('tabbrowser-tabs');
				tabBrowserTabs._positionPinnedTabs();
			}
		}
	}
	if (!keepSmallBadge) {
		let tabBadgeLayer = document.getAnonymousElementByAttribute(tab, 'anonid', BADGE_LAYER_ANONID);
		if (tabBadgeLayer) {
			tabBadgeLayer.parentNode.removeChild(tabBadgeLayer);
		}
		let tabIcon = document.getAnonymousElementByAttribute(tab, 'class', 'tab-icon-image');
		tabIcon.style.display = null;

		if (!keepBadge) {
			tab.removeAttribute('badgevalue');
		}
	}
}

// this function fixes a 'bug' in xbl which occurs because we break the binding
function fixBinding(event) {
	let tab = event.target;
	let tabBadgeSmall = tab.ownerDocument.getAnonymousElementByAttribute(tab, 'anonid', BADGE_SMALL_ANONID);
	let closeButton = getCloseButton(tab);
	if (!closeButton) {
		Cu.reportError(strings.GetStringFromName('error.conflict'));
	}

	switch (event.type) {
	case 'TabPinned':
		if (tabBadgeSmall) {
			tabBadgeSmall.setAttribute('pinned', 'true');
		}
		if (closeButton) {
			closeButton.setAttribute('pinned', 'true');
		}
		break;
	case 'TabUnpinned':
		if (tabBadgeSmall) {
			tabBadgeSmall.removeAttribute('pinned');
		}
		if (closeButton) {
			closeButton.removeAttribute('pinned');
		}
		break;
	case 'TabAttrModified':
		if (!closeButton) {
			return;
		}
		if (tab.selected)
			closeButton.setAttribute('selected', 'true');
		else
			closeButton.removeAttribute('selected');

		if (tab.hasAttribute('visuallyselected'))
			closeButton.setAttribute('visuallyselected', 'true');
		else
			closeButton.removeAttribute('visuallyselected');
		break;
	}
}

function getCloseButton(tab) {
	let chromeDocument = tab.ownerDocument;
	let closeButton = chromeDocument.getAnonymousElementByAttribute(tab, 'anonid', 'close-button');
	if (!closeButton) {
		// look for the Tab Mix Plus close button
		let tmpCloseButton = chromeDocument.getAnonymousElementByAttribute(tab, 'anonid', 'tmp-close-button');
		if (tmpCloseButton) {
			// Tab Mix Plus has two close buttons, which is just annoying
			closeButton = tmpCloseButton.parentNode.lastChild;
		}
	}
	return closeButton;
}

function updateOnRearrange(event) {
	updateBadge(event.target);
}

function updateOnSessionRestore(event) {
	let win = event.target;
	enumerateWindowTabs(win, updateBadge);
}

function drawNumber(document, number) {
	number = number.toString();
	let c = document.createElementNS(XHTMLNS, 'canvas');
	c.width = c.height = 16;
	let cx = c.getContext('2d');
	cx.save();
	cx.translate(15, 0);
	for (let i = number.length - 1; i >= 0; i--) {
		drawDigit(cx, number.substring(i, i + 1));
	}
	cx.restore();
	return c.toDataURL();
}
function drawDigit(cx, digit) {
	cx.fillStyle = backcolor;
	if (digit == 1) {
		cx.translate(-2, 0);
		cx.fillRect(0, 9, 3, 7);
		cx.fillStyle = forecolor;
		cx.fillRect(1, 10, 1, 5);
		return;
	}

	cx.translate(-5, 0);
	if (digit == 0 || digit == 2 || digit == 3 || digit == 5 || digit == 8)
		cx.fillRect(0, 9, 6, 7);
	else if (digit == 4 || digit == 9) {
		cx.fillRect(0, 9, 6, 5);
		cx.fillRect(3, 11, 3, 5);
	} else if (digit == 6) {
		cx.fillRect(0, 9, 3, 5);
		cx.fillRect(0, 11, 6, 5);
	} else if (digit == 7) {
		cx.fillRect(0, 9, 6, 3);
		cx.fillRect(3, 11, 3, 5);
	}

	cx.fillStyle = forecolor;
	if (digit == 0 || digit == 2 || digit == 3 || digit == 5 || digit == 7 || digit == 8 || digit == 9)
		cx.fillRect(1, 10, 4, 1);
	if (digit == 2 || digit == 3 || digit == 4 || digit == 5 || digit == 6 || digit == 8 || digit == 9)
		cx.fillRect(1, 12, 4, 1);
	if (digit == 0 || digit == 2 || digit == 3 || digit == 5 || digit == 6 || digit == 8)
		cx.fillRect(1, 14, 4, 1);
	if (digit == 0 || digit == 4 || digit == 5 || digit == 6 || digit == 8 || digit == 9)
		cx.fillRect(1, 10, 1, 3);
	if (digit == 0 || digit == 2 || digit == 3 || digit == 4 || digit == 7 || digit == 8 || digit == 9)
		cx.fillRect(4, 10, 1, 3);
	if (digit == 0 || digit == 2 || digit == 6 || digit == 8)
		cx.fillRect(1, 12, 1, 3);
	if (digit == 0 || digit == 3 || digit == 4 || digit == 5 || digit == 6 || digit == 7 || digit == 8 || digit == 9)
		cx.fillRect(4, 12, 1, 3);
}

function logError(message) {
	let frame = Components.stack.caller;
	let filename = frame.filename ? frame.filename.split(' -> ').pop() : null;
	let scriptError = Cc['@mozilla.org/scripterror;1'].createInstance(Ci.nsIScriptError);
	scriptError.init(
		message, filename, null, frame.lineNumber, frame.columnNumber,
		Ci.nsIScriptError.infoFlag, 'component javascript'
	);
	Services.console.logMessage(scriptError);
}
