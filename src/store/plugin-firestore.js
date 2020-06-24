/* globals alert */
// Firestore plugin
import firebase from '@firebase/app';
import '@firebase/auth';
import '@firebase/firestore';
import '@firebase/storage';
import {defaults as _defaults} from 'underscore';

import Config from '../background/js/config';
import firebaseConfig from './config-firebase';

import _GORGIAS_API_PLUGIN from './plugin-api';

// firebase
firebase.initializeApp(firebaseConfig);

var db = firebase.firestore();
var storageRef = firebase.storage().ref();

function mock () {
    return Promise.resolve();
}

function fsDate (date) {
    if (!date) {
        return firebase.firestore.Timestamp.now();
    }

    return firebase.firestore.Timestamp.fromDate(date);
}

function now () {
    return fsDate(new Date());
}

// convert firestore timestamps to dates
function convertToNativeDates (obj = {}) {
    var parsed = Object.assign({}, obj);
    Object.keys(parsed).forEach((prop) => {
        if (parsed[prop] && typeof parsed[prop].toDate === 'function') {
            parsed[prop] = parsed[prop].toDate();
        }
    });

    return parsed;
}

// backwards compatible template for the angular app
function compatibleTemplate(template = {}, tags = []) {
    var cleanTemplate = Object.assign(
        {},
        template,
        {
            // backwards compatibility
            tags: tags.join(', '),
            deleted: isDeleted(template),
            private: isPrivate(template),
            remote_id: template.id,
            nosync: 0
        }
    );

    // convert dates
    return convertToNativeDates(cleanTemplate);
}

// uuidv4
function uuid() {
    return `${1e7}-${1e3}-${4e3}-${8e3}-${1e11}`.replace(/[018]/g, c =>
        (c ^ window.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

// handle fetch errors
function handleErrors (response) {
    if (!response.ok) {
        return response.clone().json().then((res) => {
            return Promise.reject(res);
        });
    }
    return response;
}

// fetch wrapper
// support authorization header, form submit, query params, error handling
function request (url, params = {}) {
    const defaults = {
        authorization: false,
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        },
        body: {}
    };

    // deep-merge work-around
    const paramsCopy = JSON.parse(JSON.stringify(params));
    const data = Object.assign({}, defaults, paramsCopy);
    data.method = data.method.toUpperCase();

    // form post support
    if (params.form === true) {
        const $form = document.createElement('form');
        $form.setAttribute('method', params.method);
        $form.setAttribute('action', url);
        $form.setAttribute('target', '_blank');

        Object.keys(params.body).forEach((key) => {
            const $input = document.createElement('input');
            $input.type = 'hidden';
            $input.name = key;
            $input.value = params.body[key];
            $form.appendChild($input);
        });

        document.body.appendChild($form);
        $form.submit();

        return;
    }

    // querystring support
    const fullUrl = new URL(url);
    if (data.method === 'GET') {
        Object.keys(data.body).forEach((key) => {
            fullUrl.searchParams.append(key, data.body[key]);
        });

        delete data.body;
    } else {
        // stringify body for non-get requests
        data.body = JSON.stringify(data.body);
    }

    // auth support
    let auth = Promise.resolve();
    if (data.authorization) {
        auth = getUserToken();
    }

    return auth.then((res) => {
            if (res) {
                data.headers.Authorization = `Bearer ${res.token}`;
            }

            return fetch(fullUrl, {
                    method: data.method,
                    headers: data.headers,
                    body: data.body
                })
                .then(handleErrors)
                .then((res) => res.json());
        });
}

// backwards compatibility
// update template list
function refreshTemplates () {
    // invalidate cache
    invalidateTemplateCache();
    // backwards compatibility
    window.store.trigger('templates-sync');
}

// local data (when logged-out)
var localDataKey = 'firestoreLocalData';
function getLocalData (params = {}) {
    return new Promise((resolve) => {
        chrome.storage.local.get(localDataKey, (res) => {
            var localData = Object.assign({
                tags: {},
                templates: {}
            }, res[localDataKey]);

            var result = [];

            if (params.raw) {
                // return raw data
                result = localData;
            } else if (params.templateId) {
                // return one template
                result = localData.templates[params.templateId];
            } else {
                // return all tags or templates
                ['tags', 'templates'].some((key) => {
                    if (params[key]) {
                        // return all items as array
                        result = Object.keys(localData[key]).map((id) => {
                            return localData[key][id];
                        }).filter((item) => {
                            // don't return deleted data
                            return !item.deleted_datetime;
                        });

                        return true;
                    }
                });
            }

            resolve(result);
        });
    });
}

var batchLocalDataUpdate = Promise.resolve();
function updateLocalData (params = {}) {
    // batch update, to avoid overwriting data on parallel calls
    batchLocalDataUpdate = batchLocalDataUpdate.then(() => {
        return new Promise((resolve) => {
            getLocalData({raw: true}).then((res) => {
                // merge defaults with stored data
                var localData = Object.assign({
                    templates: {},
                    tags: {}
                }, res);

                ['tags', 'templates'].forEach((key) => {
                    if (params[key]) {
                        params[key].forEach((item) => {
                            // merge existing data
                            localData[key][item.id] = Object.assign({}, localData[key][item.id], item);
                        });
                    }
                });

                var localDataContainer = {};
                localDataContainer[localDataKey] = localData;
                chrome.storage.local.set(localDataContainer, () => {
                    // refresh template list
                    refreshTemplates();

                    resolve();
                });
            });
        });
    });

    return batchLocalDataUpdate;
}

function syncLocalData () {
    var batch = db.batch();
    var user = {};
    return getSignedInUser()
        .then((res) => {
            user = res;
            return Promise.all([
                getLocalData({tags: true}),
                getLocalData({templates: true})
            ]);
        })
        .then((res) => {
            var tags = res[0];
            var templates = res[1];

            tags.forEach((tag) => {
                var ref = tagsCollection.doc(tag.id);
                delete tag.id;
                tag.customer = user.customer;
                batch.set(ref, tag);
            });

            return Promise.all(
                templates.map((template) => {
                    var ref = templatesCollection.doc(template.id);
                    var update = false;

                    return ref.get()
                        .then((res) => {
                            // template exists, check modified_datetime
                            var data = res.data();
                            var modified_datetime = new firebase.firestore.Timestamp(
                                template.modified_datetime.seconds,
                                template.modified_datetime.nanoseconds
                            );
                            if (
                                data.modified_datetime &&
                                modified_datetime.toDate() > data.modified_datetime.toDate()
                            ) {
                                update = true;

                                // sharing is set to none on new templates.
                                // prevent making existing templates private.
                                template = Object.assign(template, {
                                    sharing: data.sharing,
                                    shared_with: data.shared_with
                                });
                            }
                        })
                        .catch(() => {
                            // template doesn't exist
                            update = true;
                        })
                        .then(() => {
                            if (update) {
                                delete template.id;
                                template.owner = user.id;
                                template.customer = user.customer;
                                // convert dates
                                [
                                    'created_datetime',
                                    'deleted_datetime',
                                    'modified_datetime',
                                    'lastuse_datetime'
                                ].forEach((prop) => {
                                    if (template[prop]) {
                                        template[prop] = new firebase.firestore.Timestamp(
                                            template[prop].seconds,
                                            template[prop].nanoseconds
                                        );
                                    }
                                });

                                batch.set(ref, template, {merge: true});
                            }

                            return;
                        });
                })
            );
        })
        .then(() => {
            return batch.commit();
        })
        .then(() => {
            // clear local data
            return clearLocalTemplates();
        })
        .catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return;
            }

            throw err;
        });
}

// migrate legacy local (logged-out) templates to new local format.
// check if storage item is legacy template
function isLegacyTemplate (key = '', template = {}) {
    return (
        // key is uuid
        key.length === 36 && key.split('-').length === 5 &&
        // template has body
        template.body &&
        // template has id
        template.id
    );
}

function migrateLegacyLocalData () {
    return new Promise((resolve) => {
        chrome.storage.local.get(null, resolve);
    }).then((storage) => {
        return Promise.all(
            Object.keys(storage || {}).map((key) => {
                var template = storage[key];
                if (isLegacyTemplate(key, template)) {
                    var localId = template.id;
                    var remoteId = template.remote_id || localId;

                    return parseTemplate({
                        template: template
                    }).then((res) => {
                        // update local data
                        return updateLocalData({
                            templates: [
                                Object.assign({id: remoteId}, res)
                            ]
                        }).then(() => {
                            return localId;
                        });
                    });
                }

                return;
            })
        );
    }).then((ids = []) => {
        const migratedTemplates = ids.filter((id) => !!id);
        // delete legacy data
        chrome.storage.local.remove(migratedTemplates);
        return;
    });
}

// HACK borrow settings from old api plugin
let cachedSettings = null;
var getSettings = (params = {}) => {
    if (params.key === 'settings') {
        let localSettings = {};
        return _GORGIAS_API_PLUGIN.getSettings(params)
            .then((settings) => {
                localSettings = settings;
                if (cachedSettings) {
                    return cachedSettings;
                }

                return getSignedInUser()
                    .then((user) => {
                        return usersCollection.doc(user.id).get();
                    })
                    .then((userDoc) => {
                        const userSettings = userDoc.data().settings;
                        const settings = Object.assign(defaultSettings(localSettings), userSettings);

                        // backwards compatibility
                        // map to old format
                        cachedSettings = Object.assign({}, localSettings, {
                            keyboard: {
                                enabled: settings.expand_enabled,
                                shortcut: settings.expand_shortcut
                            },
                            dialog: {
                                enabled: settings.dialog_enabled,
                                shortcut: settings.dialog_shortcut,
                                limit: settings.dialog_limit
                            },
                            qaBtn: {
                                enabled: settings.dialog_button
                            },
                            editor: {
                                enabled: settings.rich_editor
                            },
                            blacklist: settings.blacklist,
                            is_sort_template_dialog_gmail: settings.dialog_sort,
                            is_sort_template_list: settings.dashboard_sort
                        });

                        return cachedSettings;
                    });
            });

    }

    return _GORGIAS_API_PLUGIN.getSettings(params);
};

var setSettings = (params = {}) => {
    if (params.key === 'settings') {
        return _GORGIAS_API_PLUGIN.setSettings(params)
            .then(() => {
                return syncSettings();
            });
    }

    return _GORGIAS_API_PLUGIN.setSettings(params);
};

var LOGGED_OUT_ERR = 'logged-out';
function isLoggedOut (err) {
    return err === LOGGED_OUT_ERR;
}

var globalUserKey = 'firebaseUser';
function getSignedInUser () {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(globalUserKey, (res) => {
            const user = res[globalUserKey] || {};
            if (Object.keys(user).length) {
                return resolve(user);
            }

            return reject(LOGGED_OUT_ERR);
        });
    });
}

function setSignedInUser (user) {
    return new Promise((resolve) => {
        var globalUser = {};
        globalUser[globalUserKey] = user;
        chrome.storage.local.set(globalUser, () => {
            resolve();
        });
    });
}

// firebase.auth().currentUser is not a promise
// https://github.com/firebase/firebase-js-sdk/issues/462
function getCurrentUser () {
    return new Promise((resolve, reject) => {
        var unsubscribe = firebase.auth().onAuthStateChanged((user) => {
            unsubscribe();
            resolve(user);
        }, reject);
    });
}

var snapshotListeners = [];
function subscribeSnapshots (listeners = []) {
    snapshotListeners = snapshotListeners.concat(listeners);
}

function unsubscribeSnapshots () {
    snapshotListeners.forEach((unsubscriber) => {
        unsubscriber();
    });
}

// auth change
firebase.auth().onAuthStateChanged((firebaseUser) => {
    if (!firebaseUser) {
        invalidateTemplateCache();
        unsubscribeSnapshots();

        return setSignedInUser({});
    }

    return updateCurrentUser(firebaseUser).then(() => {
        return getSignedInUser()
            .then((user) => {
                // refresh templates on changes
                subscribeSnapshots([
                    templatesOwnedQuery(user).onSnapshot(refreshTemplates),
                    templatesSharedQuery(user).onSnapshot(refreshTemplates),
                    templatesEveryoneQuery(user).onSnapshot(refreshTemplates),
                    // customer changes (eg. subscription updated)
                    customersCollection.doc(user.customer).onSnapshot(() => {
                        updateCurrentUser(firebaseUser);
                    })
                ]);

                // populate in-memory template cache
                getTemplate();
            })
            .catch((err) => {
                if (isLoggedOut(err)) {
                    // logged-out
                    return;
                }

                throw err;
            });
    });
});

var getLoginInfo = getSignedInUser;
var getAccount = getSignedInUser;

// update account details
var setAccount = (params = {}) => {
    var currentUser = firebase.auth().currentUser;
    var userRef = usersCollection.doc(currentUser.uid);

    return userRef.get().then((user) => {
        var userData = user.data();
        var updates = [];

        if (currentUser.email !== params.email) {
            updates.push(
                currentUser.updateEmail(params.email).then(() => {
                    // only if auth update successful
                    // update email in users collection
                    return userRef.update({email: params.email});
                })
            );
        }

        if (userData.full_name !== params.name) {
            updates.push(
                userRef.update({full_name: params.name})
            );
        }

        return Promise.all(updates).then(() => {
            // update details in cached user
            return updateCurrentUser(firebase.auth().currentUser);
        }).then(() => {
            // update password last, it invalidates the session
            if (params.password) {
                return currentUser.updatePassword(params.password).then(() => {
                    // automatically sign-in with new credentials
                    return signin({
                        email: params.email,
                        password: params.password
                    });
                });
            }

            return;
        }).catch((err) => {
            // TODO show error message in UI
            if (err.message) {
                alert(err.message);
                return Promise.reject();
            }
        });
    });
};

var usersCollection = db.collection('users');
var customersCollection = db.collection('customers');
var templatesCollection = db.collection('templates');
var tagsCollection = db.collection('tags');

function idsToUsers (userIds = []) {
    return Promise.all(
        userIds.map((id) => {
            return usersCollection.doc(id).get().then((userQuery) => {
                var userData = userQuery.data();
                return Object.assign({
                    // backwards compatibility
                    active: true,
                    id: userQuery.id,
                    email: userData.email,
                    name: userData.full_name
                }, userData);
            });
        })
    );
}

var getMembers = (params = {exclude: null}) => {
    return getSignedInUser().then((user) => {
        return customersCollection.doc(user.customer).get().then((customer) => {
            var members = customer.data().members;
            var exclude = params.exclude;
            // by default exclude ourselves.
            // null is default, otherwise []
            if (exclude === null) {
                exclude = [user.id];
            }

            // exclude users
            members = members.filter((memberId) => {
                return !exclude.includes(memberId);
            });
            return idsToUsers(members);
        });
    }).then((members) => {
        return {
            members: members.map((member) => {
                return Object.assign({
                    active: true
                }, member);
            })
        };
    });
};

// update customer members
var setMember = (params = {}) => {
    return getUserToken().then((res) => {
            return fetch(`${Config.functionsUrl}/api/1/member`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token: res.token,
                    id: params.id,
                    active: params.active,
                    email: params.email,
                    name: params.name,
                    customer: res.user.customer
                })
            })
            .then(handleErrors)
            .then((res) => res.json());
        });
};

function getTags () {
    return getSignedInUser()
        .then((user) => {
            return tagsCollection.where('customer', '==', user.customer).get();
        })
        .then((snapshot) => {
            return snapshot.docs.map((tag) => {
                return Object.assign({id: tag.id}, tag.data());
            });
        })
        .catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return getLocalData({tags: true});
            }

            throw err;
        });
}

function createTags (tags = []) {
    if (!tags.length) {
        return Promise.resolve([]);
    }

    var newTags = tags.map((tag) => {
        var newTag = {
            title: tag,
            version: 1
        };
        return Object.assign({
            id: uuid()
        }, newTag);
    });

    return getSignedInUser()
        .then((user) => {
            var batch = db.batch();
            newTags.forEach((tag) => {
                var ref = tagsCollection.doc(tag.id);
                var tagData = {
                    customer: user.customer,
                    title: tag.title,
                    version: tag.version
                };
                batch.set(ref, tagData);
            });

            return batch.commit();
        })
        .catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return updateLocalData({
                    tags: newTags
                });
            }

            throw err;
        })
        .then(() => newTags);
}

function tagsToArray (tagsString = '') {
    return (tagsString || '').split(',').map((tag) => {
        return (tag || '').trim();
    }).filter((tag) => !!tag);
}

// replace tag titles with ids
function tagsToIds (templateTags) {
    return getTags().then((existingTags) => {
        // tags to be created
        var newTags = templateTags.filter((tag) => {
            return !(existingTags.some((existing) => {
                return existing.title === tag;
            }));
        });

        return createTags(newTags).then((createdTags) => {
            // merge existing tags with created tags
            var updatedTags = existingTags.concat(createdTags);

            // map template tag titles to ids
            return templateTags.map((tag) => {
                return (
                    updatedTags.find((existingTag) => {
                        return existingTag.title === tag;
                    }) || {}
                ).id;
            });
            });
    });
}

function idsToTags (tagIds) {
    return getTags().then((existingTags) => {
        return tagIds.map((tagId) => {
            var foundTag = existingTags.find((tag) => {
                return tagId === tag.id;
            });

            if (!foundTag) {
                return '';
            }

            return foundTag.title;
        });
    });
}

function parseTemplate (params = {}) {
    // private by default
    // sharing later set by updateSharing
    var sharing = 'none';
    var shared_with = [];
    var createdDatetime = params.template.created_datetime ? new Date(params.template.created_datetime) : null;
    var modifiedDatetime = params.template.modified_datetime ? new Date(params.template.modified_datetime) : null;
    var deletedDatetime = params.template.deleted_datetime ? new Date(params.template.deleted_datetime) : null;
    var lastuseDatetime = params.template.lastuse_datetime ? new Date(params.template.lastuse_datetime) : null;

    var template = {
        title: params.template.title || null,
        body: params.template.body || null,
        shortcut: params.template.shortcut || '',
        subject: params.template.subject || '',
        cc: params.template.cc || '',
        bcc: params.template.bcc || '',
        to: params.template.to || '',
        attachments: params.template.attachments || [],
        created_datetime: fsDate(createdDatetime),
        modified_datetime: fsDate(modifiedDatetime),
        deleted_datetime: deletedDatetime ? fsDate(deletedDatetime) : null,
        shared_with: shared_with,
        sharing: sharing,
        tags: [],
        owner: null,
        customer: null,
        // stats
        lastuse_datetime: lastuseDatetime ? fsDate(lastuseDatetime) : null,
        use_count: 0,
        version: 1
    };

    // clean-up template tags
    var templateTags = tagsToArray(params.template.tags || '');

    return getSignedInUser()
        .then((user) => {
            template = Object.assign(template, {
                owner: user.id,
                customer: user.customer
            });
            return;
        }).catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return;
            }

            throw err;
        }).then(() => {
            return tagsToIds(templateTags);
        }).then((tags) => {
            return Object.assign(template, {
                tags: tags
            });
        });
}

function templatesOwnedQuery (user) {
    return templatesCollection
        .where('customer', '==', user.customer)
        .where('owner', '==', user.id)
        .where('deleted_datetime', '==', null);
}

// my templates
function getTemplatesOwned (user) {
    return templatesOwnedQuery(user)
        .get();
}

function templatesSharedQuery (user) {
    return templatesCollection
        .where('customer', '==', user.customer)
        .where('shared_with', 'array-contains', user.id)
        .where('deleted_datetime', '==', null);
}

// templates shared with me
function getTemplatesShared (user) {
    return templatesSharedQuery(user)
        .get();
}

function templatesEveryoneQuery (user) {
    return templatesCollection
        .where('customer', '==', user.customer)
        .where('sharing', '==', 'everyone')
        .where('deleted_datetime', '==', null);
}

// templates shared with everyone
function getTemplatesForEveryone (user) {
    return templatesEveryoneQuery(user)
        .get();
}

// template in-memory cache
var templateCache = {};
function addTemplatesToCache (templates = {}) {
    Object.keys(templates).forEach((templateId) => {
        templateCache[templateId] = templates[templateId];
    });
}

function getTemplatesFromCache (templateId) {
    if (templateId && templateCache[templateId]) {
        var list = {};
        list[templateId] = templateCache[templateId];
        return Promise.resolve(list);
    }

    if (Object.keys(templateCache).length) {
        return Promise.resolve(templateCache);
    }

    return Promise.reject();
}

function invalidateTemplateCache () {
    templateCache = {};
}

function isPrivate (template = {}) {
    return (template.sharing === 'none');
}

function isDeleted (template = {}) {
    return !!template.deleted_datetime ? 1 : 0;
}

var getTemplate = (params = {}) => {
    // return single template
    if (params.id) {
        var templateData = {};
        return getTemplatesFromCache(params.id)
            .catch(() => {
                return getSignedInUser()
                    .then(() => {
                        // template not in cache
                        return templatesCollection.doc(params.id).get()
                            .then((res) => res.data());
                    })
                    .catch((err) => {
                        if (isLoggedOut(err)) {
                            // logged-out
                            return getLocalData({
                                templateId: params.id
                            });
                        }

                        throw err;
                    })
                    .then((res) => {
                        templateData = res;
                        return idsToTags(templateData.tags);
                    })
                    .then((tags) => {
                        var template = compatibleTemplate(Object.assign({
                            id: params.id
                        }, templateData), tags);

                        // backwards compatibility
                        var list = {};
                        list[template.id] = template;
                        return list;
                    });
            });
    }

    return getTemplatesFromCache()
        .catch(() => {
            // templates not cached
            return getSignedInUser()
                .then((user) => {
                    return Promise.all([
                        getTemplatesOwned(user),
                        getTemplatesShared(user),
                        getTemplatesForEveryone(user)
                    ]).then((res) => {
                        var mergedTemplates = [];
                        // concat all templates
                        res.forEach((query) => {
                            mergedTemplates = mergedTemplates.concat(query.docs);
                        });

                        // merge data and id
                        return mergedTemplates.map((template) => {
                            return Object.assign({
                                id: template.id
                            }, template.data());
                        });
                    });
                })
                .catch((err) => {
                    if (isLoggedOut(err)) {
                        // logged-out
                        return getLocalData({templates: true});
                    }

                    throw err;
                })
                .then((allTemplates) => {
                    // backward compatibility
                    // and template de-duplication (owned and sharing=everyone)
                    var templates = {};
                    return Promise.all(
                        allTemplates.map((template) => {
                            return idsToTags(template.tags).then((tags) => {
                                templates[template.id] = compatibleTemplate(template, tags);

                                return;
                            });
                        })
                    ).then(() => {
                        addTemplatesToCache(templates);

                        return templates;
                    });
                });
        });
};

// update template details
// sharing is updated later by updateSharing
var updateTemplate = (params = {}) => {
    var updatedDate = now();
    var updatedTemplate = {};

    var stringProps = ['title', 'body', 'shortcut', 'subject', 'to', 'cc', 'bcc'];
    stringProps.forEach((prop) => {
        if (params.template.hasOwnProperty(prop)) {
            updatedTemplate[prop] = params.template[prop] || '';
        }
    });

    if (params.template.hasOwnProperty('attachments')) {
        updatedTemplate.attachments = params.template.attachments || [];
    }

    updatedTemplate.modified_datetime = updatedDate;

    var templateTags = tagsToArray(params.template.tags);
    return tagsToIds(templateTags)
        .then((tags) => {
            updatedTemplate.tags = tags;
            return getSignedInUser();
        })
        .then(() => {
            var docRef = templatesCollection.doc(params.template.id);
            return docRef.update(updatedTemplate);
        })
        .catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return updateLocalData({
                    templates: [
                        Object.assign(
                            {
                                id: params.template.id
                            },
                            updatedTemplate
                        )
                    ]
                });
            }

            throw err;
        })
        .then(() => {
            return Object.assign(
                {
                    remote_id: params.template.id
                },
                updatedTemplate
            );
        });
};

var createTemplate = (params = {}) => {
    var newTemplate = {};
    var id = uuid();

    return parseTemplate(params)
        .then((template) => {
            newTemplate = template;
            return getSignedInUser();
        })
        .then(() => {
            return templatesCollection.doc(id).set(newTemplate);
        })
        .catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return updateLocalData({
                    templates: [
                        Object.assign(
                            {
                                id: id
                            },
                            newTemplate
                        )
                    ]
                });
            }

            throw err;
        })
        .then(() => {
            return Object.assign({
                // backwards compatibility
                id: id,
                remote_id: id
            }, newTemplate);
        });
};

var deleteTemplate = (params = {}) => {
    var deletedDate = now();
    var ref = templatesCollection.doc(params.template.id);

    return getSignedInUser()
        .then(() => {
            return ref.update({
                deleted_datetime: deletedDate
            });
        })
        .catch((err) => {
            if (isLoggedOut(err)) {
                // logged-out
                return updateLocalData({
                    templates: [{
                        id: params.template.id,
                        deleted_datetime: deletedDate
                    }]
                });
            }

            throw err;
        });
};

// delete logged-out data
var clearLocalTemplates = () => {
    return new Promise((resolve) => {
        var localDataContainer = {};
        localDataContainer[localDataKey] = {};
        chrome.storage.local.set(localDataContainer, () => {
            refreshTemplates();
            resolve();
        });
    });
};

var getSharing = (params = {}) => {
    if (!params.quicktext_ids || !params.quicktext_ids.length) {
        return Promise.resolve([]);
    }

    var members = [];

    return getMembers({exclude: []}).then((res) => {
        members = res.members;
        return members;
    }).then(() => {
        return Promise.all(
            params.quicktext_ids.map((id) => {
                return templatesCollection.doc(id).get();
            })
        );
    }).then((templates) => {
        // backwards compatibility
        // add template owners to acl
        var acl = templates.map((template) => {
            return {
                target_user_id: template.data().owner
            };
        });

        return Promise.all(
            templates.map((template) => {
                var templateData = template.data();
                if (templateData.sharing === 'everyone') {
                    return members;
                }

                // if custom shared_with ids to users
                if (templateData.sharing === 'custom') {
                    // get from cached members, avoid extra requests
                    return templateData.shared_with.map((userId) => {
                        return members.find((member) => member.id === userId);
                    }).filter((userId) => {
                        // remove undefined values.
                        // fixes issues with templates shared_with
                        // members removed from customer.
                        return userId;
                    });
                }

                // private
                return [];
            })
        ).then((sharing) => {
            // merge users in acl, for multiple selected templates
            sharing.forEach((templateSharing) => {
                templateSharing.forEach((sharedUser) => {
                    // de-duplicate
                    var existing = acl.find((user) => {
                        return user.id === sharedUser.id;
                    });

                    if (!existing) {
                        acl.push(Object.assign({
                            // backwards compatibility
                            target_user_id: sharedUser.id
                        }, sharedUser));
                    }
                });
            });

            // backwards compatibility
            return {
                acl: acl
            };
        });
    });
};

function hasAll (listOne, listTwo) {
    return listTwo.every((val) => {
        return listOne.includes(val);
    });
}

var batchDeleteSharing = null;
var timerDeleteSharing = null;
var listDeleteSharing = [];
// batch delete sharing (remove one user from shared_with)
function deleteSharing (params = {}) {
    if (!batchDeleteSharing) {
        batchDeleteSharing = db.batch();
    }

    if (timerDeleteSharing) {
        clearTimeout(timerDeleteSharing);
    }

    // keep a list of updated templates
    if (!listDeleteSharing.includes(params.id)) {
        listDeleteSharing.push(params.id);
    }

    timerDeleteSharing = setTimeout(() => {
        batchDeleteSharing.commit().then(() => {
            // set sharing=none to templates with shared_with = []
            listDeleteSharing.forEach((id) => {
                // set sharing to none if share_with empty
                var ref = templatesCollection.doc(id);
                ref.get().then((template) => {
                    var templateData = template.data();
                    if (templateData.shared_with.length === 0) {
                        ref.update({
                            sharing: 'none'
                        });
                    }
                });
            });

            return;
        }).catch(() => {
            // catch errors, to always clean-up the queue
            return;
        }).then(() => {
            // clean-up
            batchDeleteSharing = null;
            listDeleteSharing = [];
            return;
        });
    }, 1000);

    var templateRef = templatesCollection.doc(params.id);
    batchDeleteSharing.update(templateRef, {
        sharing: 'custom',
        shared_with: firebase.firestore.FieldValue.arrayRemove(params.user_id)
    });
}

var updateSharing = (params = {action: 'create', acl: {}, send_email: 'false'}) => {
    if (params.action === 'delete') {
        return getSignedInUser()
            .then((user) => {
                return Promise.all(
                    // delete sends one request for each user, with params.acl.user_id
                    // batch delete requests
                    params.acl.quicktext_ids.map((id) => {
                        return getTemplate({id: id}).then((res) => {
                            var template = res[id];
                            // don't remove yourself from shared_with,
                            // if you're not the template owner.
                            // it will make the template disappear.
                            if (
                                template.owner === user.id ||
                                params.acl.user_id !== user.id
                            ) {
                                deleteSharing({
                                    id: id,
                                    user_id: params.acl.user_id
                                });
                            }

                            return;
                        });
                    })
                );
            });
    }

    // params.acl.quicktexts is map
    var templateIds = Object.keys(params.acl.quicktexts);
    var notifiedUsers = {};
    var members = [];
    var user = {};
    return getSignedInUser()
        .then((res) => {
            user = res;
            return getMembers({exclude: []});
        })
        .then((res) => {
            members = res.members;

            return Promise.all(
                templateIds.map((id) => {
                    return templatesCollection.doc(id).get();
                })
            );
        }).then((templates) => {
            return Promise.all(
                templates.map((template) => {
                    var templateData = template.data();
                    var owner = templateData.owner;
                    var emails = (params.acl.quicktexts[template.id].emails || '').split(',');
                    var sharing = 'none';
                    var shared_with = [];
                    var memberEmails = members.map((member) => member.email);
                    // backwards-compatibility.
                    // emails will never include current signed-in user,
                    // but will include current template owner.
                    // template should be shared with me, if not owned by me.
                    var everyone = hasAll(emails.concat([user.email]), memberEmails);

                    if (everyone) {
                        sharing = 'everyone';
                        // backwards compatibility
                        shared_with = members.map((member) => member.id);
                    } else if (emails.length) {
                        sharing = 'custom';
                        // emails to ids
                        shared_with = members.filter((member) => {
                            return emails.includes(member.email);
                        }).map((member) => member.id);
                    }

                    // don't share with template owner
                    shared_with = shared_with.filter((memberId) => {
                        return memberId !== owner;
                    });

                    // set notified users
                    members.forEach((member) => {
                        // exclude template owner
                        if(emails.includes(member.email) && member.id !== owner) {
                            // map for deduplication
                            notifiedUsers[member.id] = member;
                        }
                    });

                    return templatesCollection.doc(template.id).update({
                        sharing: sharing,
                        shared_with: shared_with
                    });
                })
            );
        }).then(() => {
            // send_email is string
            if (params.send_email === 'true') {
                var users = Object.keys(notifiedUsers).map((id) => notifiedUsers[id]);
                shareNotification({
                    users: users,
                    templates: templateIds,
                    message: params.acl.message
                });
            }

            return;
        });
};

function shareNotification (params = {}) {
    return getUserToken().then((res) => {
            return fetch(`${Config.functionsUrl}/api/1/share`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token: res.token,
                    users: params.users,
                    templates: params.templates,
                    message: params.message
                })
            })
            .then(handleErrors)
            .then((res) => res.json());
        });
}

var getStats = mock;

var getSubscription = () => {
    return getSignedInUser()
        .then((user) => {
            return request(`${Config.functionsUrl}/api/1/subscription`, {
                authorization: true,
                body: {
                    customer: user.customer
                }
            });
        })
        .then((res) => {
            return Object.assign({
                active: !!res.canceled_datetime
            }, res);
        });
};

// return user and token
function getUserToken () {
    return getCurrentUser().then((currentUser) => {
        return currentUser.getIdToken(true);
    }).then((token) => {
        return getSignedInUser().then((user) => {
            return {
                user: user,
                token: token
            };
        });
    });
}

// update subscription plan and quantity
var updateSubscription = (params = {}) => {
    return getSignedInUser()
        .then((user) => {
            return request(`${Config.functionsUrl}/api/1/subscription`, {
                    authorization: true,
                    method: 'PUT',
                    body: {
                        customer: user.customer,
                        quantity: params.quantity,
                        plan: params.plan
                    }
                });
        })
        .then(() => {
            return 'Successfully updated subscription.';
        })
        .catch((err) => {
            return Promise.reject(err.message);
        });
};

var cancelSubscription = () => {
    return getUserToken().then((res) => {
        return fetch(`${Config.functionsUrl}/api/1/subscription`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token: res.token,
                    customer: res.user.customer
                })
            })
            .then(handleErrors)
            .then((res) => res.json())
            .then(() => {
                return 'Successfully canceled subscription.';
            })
            .catch((err) => {
                return Promise.reject(err.message);
            });
    });
};

var updateCreditCard = () => {
    return getUserToken()
        .then((res) => {
            return request(`${Config.functionsUrl}/api/1/subscription`, {
                form: true,
                method: 'POST',
                body: {
                    token: res.token,
                    customer: res.user.customer,
                    payment_update: true
                }
            });
        });
};

var createSubscription = (params = {}) => {
    return getUserToken()
        .then((res) => {
            return request(`${Config.functionsUrl}/api/1/subscription`, {
                form: true,
                method: 'POST',
                body: {
                    token: res.token,
                    customer: res.user.customer,
                    quantity: params.quantity,
                    plan: params.plan
                }
            });
        });
};

// backwards compatibility
function signinError (err) {
    if (err && err.code === 'auth/too-many-requests') {
        // recaptcha verifier is not supported in chrome extensions
        // only http/https
        err.message = 'Too many unsuccessful login attempts. Please try again later. ';
    }

    throw {
        error: err.message || 'There was an issue signing you in. Please try again later.'
    };
}

function updateCurrentUser (firebaseUser) {
    var userId = firebaseUser.uid;
    var user = {
        id: userId,
        email: firebaseUser.email,
        created_datetime: new Date(firebaseUser.metadata.creationTime)
    };

    // HACK firestore throws an insufficient permissions error
    // if we trigger immediately after signInWithEmailAndPassword()
    var delay = new Promise((resolve) => {
        setTimeout(resolve, 500);
    });

    return delay
        .then(() => {
            // get data from users collection
            return usersCollection.doc(userId).get();
        })
        .then((userDoc) => {
            // get data from users collection
            var userData = userDoc.data();
            user = Object.assign(user, {
                // only support one customer for now
                customer: userData.customers[0],
                // backwards compatibility
                info: {
                    name: userData.full_name,
                    share_all: userData.share_all || false
                },
                editor: {
                    enabled: true
                },
                is_loggedin: true,
                created_datetime: '',
                current_subscription: {
                    active: false,
                    created_datetime: '',
                    plan: '',
                    quantity: 1
                },
                is_staff: false
            });

            return customersCollection.doc(user.customer).get();
        })
        .then((customer) => {
            var customerData = customer.data();
            var isCustomer = false;
            if (customerData.owner === user.id) {
                isCustomer = true;
            }

            user = Object.assign({
                is_customer: isCustomer
            }, user);

            // subscription data
            user.current_subscription = Object.assign(user.current_subscription, {
                plan: customerData.subscription.plan,
                quantity: customerData.subscription.quantity
            });

            if (!customerData.subscription.canceled_datetime) {
                user.current_subscription.active = true;
            }

            return setSignedInUser(user);
        });
}

var signin = (params = {}) => {
    return firebase.auth().signInWithEmailAndPassword(params.email, params.password)
        .then((authRes) => {
            return updateCurrentUser(authRes.user);
        }).catch((err) => {
            return signinError(err);
        });
};

var forgot = (params = {}) => {
    return firebase.auth().sendPasswordResetEmail(params.email)
        .catch((err) => {
            return signinError(err);
        });
};

var logout = () => {
    return firebase.auth().signOut().then(() => {
        return setSignedInUser({});
    });
};

function signinWithToken (token = '') {
    return firebase.auth().signInWithCustomToken(token)
        .then((res) => {
            return updateCurrentUser(res.user);
        });
}

window.SIGNIN_WITH_TOKEN = signinWithToken;

var impersonate = function (params = {}) {
    return getUserToken().then((res) => {
        return fetch(`${Config.functionsUrl}/api/1/impersonate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    uid: params.id,
                    token: res.token
                })
            })
            .then(handleErrors)
            .then((res) => res.json());
    }).then((res) => {
        return signinWithToken(res.token);
    });
};

// make impersonate public
window.IMPERSONATE = impersonate;

var importTemplates = () => {
    return Promise.resolve({
        firebase: true
    });
};

// map old settings to new format
function defaultSettings (oldSettings = {}) {
    const defaults = {
        // tab expand
        expand_enabled: true,
        expand_shortcut: 'tab',
        // dialog
        dialog_enabled: true,
        dialog_button: true,
        dialog_shortcut: 'ctrl+space',
        dialog_limit: 100,
        // dialog sort alphabetically
        dialog_sort: false,
        // rich editor
        rich_editor: true,
        // blacklist
        blacklist: [],
        // dashboard sort alphabetically
        dashboard_sort: false,
    };

    const mappedSettings = {
        expand_enabled: oldSettings.keyboard.enabled,
        expand_shortcut: oldSettings.keyboard.shortcut,
        dialog_enabled: oldSettings.dialog.enabled,
        dialog_button: oldSettings.qaBtn.enabled,
        dialog_shortcut: oldSettings.dialog.shortcut,
        dialog_limit: oldSettings.dialog.limit,
        dialog_sort: oldSettings.is_sort_template_dialog_gmail,
        rich_editor: oldSettings.editor.enabled,
        blacklist: oldSettings.blacklist,
        dashboard_sort: oldSettings.is_sort_template_list
    };

    // merge default with existing
    return _defaults(Object.assign({}, mappedSettings), defaults);
}

// save local settings in the db
function syncSettings () {
    // invalidate settings cache
    cachedSettings = null;
    const settingsMap = {};
    return _GORGIAS_API_PLUGIN.getSettings({
            key: 'settings'
        })
        .then((res) => {
            const settings = defaultSettings(res);
            Object.keys(settings).forEach((key) => {
                settingsMap[`settings.${key}`] = settings[key];
            });

            return getSignedInUser();
        })
        .then((user) => {
            return usersCollection.doc(user.id).update(settingsMap);
        });
}

// sync local data when starting the app
var syncNow = function () {
    // migrate legacy templates from chrome storage
    return migrateLegacyLocalData()
        .then(() => {
            // sync local templates
            return syncLocalData();
        })
        .then(() => {
            return syncSettings();
        });
};

var addAttachments = function (params = {}) {
    var attachments = storageRef.child('attachments');
    var userId = 0;

    return getSignedInUser()
        .then((user) => {
            userId = user.id;
            return;
        })
        .then(() => {
            return Promise.all(
                params.files.filter((f) => {
                    if (f.size > 3 * 1024 * 1024) {
                        alert(`Couldn't attach ${f.name}. The file is larger than 3MB.`);
                        return false;
                    }
                    return true;
                }).map((f) => {
                    return fetch(f.url)
                        .then((res) => res.blob())
                        .then((blob) => {
                            var extension = f.name.split('.').pop();
                            var name = `${uuid()}.${extension}`;
                            var metadata = {
                                public_name: f.name,
                                user_id: userId
                            };

                            var ref = attachments.child(name);
                            return ref.put(blob, {
                                customMetadata: metadata
                            }).then(() => {
                                // revoke object url
                                URL.revokeObjectURL(f);
                                return ref.getDownloadURL();
                            }).then((url) => {
                                return {
                                    url: url,
                                    name: metadata.public_name
                                };
                            });
                        });
                })
            );
        }).catch((err = {}) => {
            // normalize error message
            var normalizedError = err;
            if (err.message_) {
                normalizedError = {
                    message: err.message_
                };
            }
            return Promise.reject(normalizedError);
        });
};

function getAttachmentFileName (url) {
    var parsedUrl = new URL(url);
    return decodeURIComponent(parsedUrl.pathname).split('/attachments/').pop();
}

var removeAttachments = function (params = {}) {
    var attachments = storageRef.child('attachments');
    return Promise.all(
        params.attachments.map((a) => {
            // get ref to file based on full url
            // firebase-js-sdk does not support getReferenceFromUrl()
            var filename = getAttachmentFileName(a.url);
            var ref = attachments.child(filename);
            return ref.delete();
        })
    );
};

window.addEventListener('message', function (event) {
    if (event.data.type === 'gorgias_message' && event.data.message === 'subscribe_success') {
        updateCurrentUser(firebase.auth().currentUser);
        window.store.trigger('subscribe-success');
    }
});

export default {
    getSettings: getSettings,
    setSettings: setSettings,

    getLoginInfo: getLoginInfo,
    getAccount: getAccount,
    setAccount: setAccount,

    getMembers: getMembers,
    setMember: setMember,

    getTemplate: getTemplate,
    updateTemplate: updateTemplate,
    createTemplate: createTemplate,
    deleteTemplate: deleteTemplate,
    clearLocalTemplates: clearLocalTemplates,

    getSharing: getSharing,
    updateSharing: updateSharing,

    getStats: getStats,

    getSubscription: getSubscription,
    updateSubscription: updateSubscription,
    cancelSubscription: cancelSubscription,
    updateCreditCard: updateCreditCard,
    createSubscription: createSubscription,

    addAttachments: addAttachments,
    removeAttachments: removeAttachments,

    syncNow: syncNow,

    signin: signin,
    logout: logout,
    forgot: forgot,
    importTemplates: importTemplates
};
