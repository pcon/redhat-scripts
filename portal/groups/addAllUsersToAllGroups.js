process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

var axios = require('axios');
var bunyan = require('bunyan');
var lodash = require('lodash');
var Q = require('q');
var URL = require('url').URL;

var credentials = require('./credentials');
var package = require('./package.json');

var UNGROUPED = '-1';
var MAX_RETRIES = 5;

global.logger = bunyan.createLogger({
    level: 'info',
    name: package.name
});

/**
 * Gets the authorization header
 * @returns {Object} The authorization header
 */
function getAuthHeaders() {
    return {
        username: credentials.username,
        password: credentials.password
    };
}

/**
 * Gets the full portal URL for a given URI
 * @param {String} uri The URI
 * @param {Object} params The query params
 * @returns {String} The full URL
 */
function getPortalUrl(uri, params) {
    var portal_url = new URL(credentials.host);
    portal_url.pathname = uri;

    lodash.forEach(params, function (value, key) {
        portal_url.searchParams.set(key, value);
    });

    return portal_url.href;
}

/**
 * Gets the data from a given URL
 * @param {String} url The URL
 * @param {Object} options The options
 * @param {Promise} deferred The promise to resolve
 * @param {Object[]} all_data All the data we've gotten so far
 * @param {Number} retry_count The current number of retries
 * @returns {undefined}
 */
function getPortalData(url, options, deferred, all_data, retry_count) {
    global.logger.debug(`Fetching ${options.data_name} from ${url}`);

    if (!all_data) {
        all_data = [];
    }

    axios.get(url,
        {
            headers: { Accept: options.accept },
            auth: getAuthHeaders()
        }
    ).then(function (result) {
        var data_selector = lodash.replace(`data.${options.data_selector}`, /\.$/, '');
        var new_data = lodash.get(result, data_selector);

        if (lodash.isArray(new_data)) {
            global.logger.trace('Resultant data is an array');
            global.logger.debug(`Currently have ${lodash.size(all_data)} ${options.data_name}`);
            global.logger.debug(`Got back ${lodash.size(new_data)} ${options.data_name}`);

            if (lodash.size(new_data) !== 0) {
                all_data = lodash.concat(all_data, new_data);
            }

            if (result.data.next) {
                getPortalData(result.data.next, options, deferred, all_data);
            } else {
                global.logger.trace('Did not get a next.  We are done');
                deferred.resolve(lodash.set({}, options.data_name, all_data));
            }
        } else if (lodash.isObject(new_data)) {
            global.logger.trace('Resultant data is an object');
            global.logger.debug(`Got back a ${options.data_name}`);
            deferred.resolve(new_data);
        } else if (lodash.isUndefined(new_data) && !lodash.isEmpty(all_data)) {
            global.logger.trace('Resultant data is undefined but we have data to return');
            deferred.resolve(lodash.set({}, options.data_name, all_data));
        } else {
            deferred.reject(new Error('Got data in a format we did not expect'));
        }
    }).catch(function (error) {
        global.logger.debug(error);
        if (
            error.response.status === 502 &&
            lodash.toInteger(retry_count) < MAX_RETRIES
        ) {
            retry_count = lodash.toInteger(retry_count) + 1;
            global.logger.error('Got back a 502, retrying');
            getPortalData(url, options, deferred, all_data, retry_count);
        } else {
            global.logger.debug(error);
            deferred.reject(new Error(error.response.statusText));
        }
    });
}

/**
 * PUT portal data
 * @param {String} url The URL to PUT to
 * @param {Object} options Additional options
 * @param {Object} deferred The promise deferral
 * @param {Object} data The data to put
 * @param {Number} retry_count The current number of retries
 * @returns {undefined}
 */
function putPortalData(url, options, deferred, data, retry_count) {
    global.logger.debug(`Putting ${options.data_name} to ${url}`);

    axios.put(url, data,
        {
            headers: { Accept: options.accept },
            auth: getAuthHeaders()
        }
    ).then(function (result) {
        deferred.resolve(result);
    }).catch(function (error) {
        global.logger.debug(error);
        if (
            error.response.status === 502 &&
            lodash.toInteger(retry_count) < MAX_RETRIES
        ) {
            retry_count = lodash.toInteger(retry_count) + 1;
            global.logger.error('Got back a 502, retrying');
            putPortalData(url, options, deferred, data, retry_count);
        } else {
            global.logger.debug(error);
            deferred.reject(new Error(error.response.statusText));
        }
    });
}

/**
 * Gets the current user
 * @returns {Promise} A promise for the current user data
 */
function getCurrentUser() {
    var deferred = Q.defer();
    var options = {
        data_selector: '',
        data_name: 'user',
        accept: 'application/vnd.redhat.user+json'
    };

    global.logger.info('Fetching current user data');
    getPortalData(getPortalUrl('/rs/users/current', {}), options, deferred);

    return deferred.promise;
}

/**
 * Gets all the users under the account
 * @returns {Promise} A promise for all the user data
 */
function getAllUsers() {
    var deferred = Q.defer();
    var options = {
        data_selector: 'user',
        data_name: 'users',
        accept: 'application/vnd.redhat.users+json'
    };

    global.logger.info('Fetching all users');
    getPortalData(getPortalUrl('/rs/users', { count: 200 }), options, deferred);

    return deferred.promise;
}

/**
 * Gets all the groups under the account
 * @returns {Promise} A promise for all the groups
 */
function getAllGroups() {
    var deferred = Q.defer();
    var options = {
        data_selector: 'group',
        data_name: 'groups',
        accept: 'application/json'
    };

    global.logger.info('Fetching all groups');
    getPortalData(getPortalUrl('/rs/groups', { count: 200 }), options, deferred);

    return deferred.promise;
}

/**
 * Gets the members of a given group
 * @param {String} account_number The account number
 * @param {String} group_number The group number
 * @returns {Promise} A promise for the group membership
 */
function getGroupMembership(account_number, group_number) {
    var deferred = Q.defer();
    var inner_deferred = Q.defer();
    var options = {
        data_selector: 'user',
        data_name: 'memberships',
        accept: 'application/json'
    };

    getPortalData(getPortalUrl(`/rs/account/${account_number}/groups/${group_number}/users`), options, inner_deferred);

    inner_deferred.promise.then(function (data) {
        deferred.resolve(lodash.set({}, group_number, data.memberships));
    });

    return deferred.promise;
}

/**
 * Gets all the existing group memberships
 * @param {Object} data The combined data
 * @returns {Promise} A promise for all the group memberships
 */
function getAllGroupMembership(data) {
    var deferred = Q.defer();
    var promises = [];

    global.logger.info('Fetching all group memberships');

    var account_number = lodash.get(data, 'current_user.account_number');
    var group_numbers = lodash.pull(lodash.map(lodash.get(data, 'groups'), 'number'), UNGROUPED);
    lodash.forEach(lodash.take(group_numbers, 2), function (group_number) {
        promises.push(getGroupMembership(account_number, group_number));
    });

    Q.allSettled(promises)
        .then(function (results) {
            var combined_data = {};
            var errors = [];

            lodash.forEach(results, function (result) {
                if (result.state === 'fulfilled') {
                    lodash.assign(combined_data, result.value);
                } else {
                    errors.push(result.reason);
                }
            });

            if (lodash.isEmpty(errors)) {
                deferred.resolve(lodash.set(data, 'membership', combined_data));
            } else {
                deferred.reject(errors);
            }
        });

    return deferred.promise;
}

/**
 * Gets all the users, groups and memberships for the account
 * @param {Object} user_data The current user
 * @returns {Promise} A promise for when all the data is gathered
 */
function getUsersGroupsAndMembership(user_data) {
    var deferred = Q.defer();

    var promises = [];

    promises.push(getAllUsers());
    promises.push(getAllGroups());

    Q.allSettled(promises)
        .then(function (results) {
            var combined_data = { current_user: user_data };
            var errors = [];

            lodash.forEach(results, function (result) {
                if (result.state === 'fulfilled') {
                    lodash.assign(combined_data, result.value);
                } else {
                    errors.push(result.reason);
                }
            });

            if (lodash.isEmpty(errors)) {
                getAllGroupMembership(combined_data)
                    .then(deferred.resolve)
                    .catch(deferred.reject);
            } else {
                deferred.reject(errors);
            }
        });

    return deferred.promise;
}

/**
 * Filters out all inactive users
 * NOTE: The /rs/users/filter endpoint does not support this operation
 * @param {Object} combined_data The combined data
 * @returns {Promise} A promise for the filtered data
 */
function filterInactiveUsers(combined_data) {
    var deferred = Q.defer();

    global.logger.info('Filtering out inactive users');

    combined_data.users = lodash.filter(combined_data.users, {is_active: true});

    global.logger.debug(`Filtered down to ${lodash.size(combined_data.users)} users`);

    deferred.resolve(combined_data);

    return deferred.promise;
}

/**
 * Builds all the new memberships we need
 * @param {Object} combined_data The combined data
 * @returns {Promise} A promise for when the memberships have been created
 */
function buildNewMembership(combined_data) {
    var deferred = Q.defer();
    combined_data.new_membership = {};

    global.logger.info('Generating needed memberships');

    lodash.forEach(combined_data.groups, function (group) {
        // Skip the un-grouped group
        if (group.number === UNGROUPED) {
            return;
        }

        lodash.set(combined_data.new_membership, `${group.number}`, []);
        lodash.forEach(combined_data.users, function (user) {
            var membership = lodash.filter(lodash.get(combined_data, `membership.${group.number}`), { sso_username: user.sso_username });

            if (
                !lodash.get(lodash.first(membership), 'write') &&
                !lodash.get(lodash.first(membership), 'org_admin')
            ) {
                lodash.get(combined_data.new_membership, `${group.number}`).push({
                    ssoUsername: user.sso_username,
                    write: true,
                    access: true
                });
            }
        });
    });

    deferred.resolve(combined_data);

    return deferred.promise;
}

/**
 * Inserts the membership records
 * @param {String} account_number The account number
 * @param {String} group_number The group number
 * @param {Object[]} members The members
 * @returns {Promise} A promise for when the members have been inserted
 */
function insertMembership(account_number, group_number, members) {
    var deferred = Q.defer();
    var options = {
        data_name: 'membership',
        accept: 'application/json'
    };

    global.logger.debug(`Inserting ${lodash.size(members)} members for group #${group_number}`);

    putPortalData(getPortalUrl(`/rs/account/${account_number}/groups/${group_number}/users`), options, deferred, {user: members});

    return deferred.promise;
}

/**
 * Inserts all the new memberships
 * @param {Object} combined_data The combined data
 * @returns {Promise} A promise for when the memberships have been inserted
 */
function insertNewMembership(combined_data) {
    var deferred = Q.defer();
    var promises = [];

    global.logger.info('Inserting new memberships');

    var account_number = lodash.get(combined_data, 'current_user.account_number');

    lodash.forEach(lodash.keys(combined_data.new_membership), function (group_number) {
        var new_membership = lodash.get(combined_data, `new_membership.${group_number}`);

        if (!lodash.isEmpty(new_membership)) {
            promises.push(insertMembership(account_number, group_number, new_membership));
        }
    });

    Q.allSettled(promises)
        .then(function (results) {
            var errors = [];

            lodash.forEach(results, function (result) {
                if (result.state !== 'fulfilled') {
                    errors.push(result.reason);
                }
            });

            if (lodash.isEmpty(errors)) {
                deferred.resolve(combined_data);
            } else {
                deferred.reject(errors);
            }
        });

    return deferred.promise;
}

getCurrentUser()
    .then(getUsersGroupsAndMembership)
    .then(filterInactiveUsers)
    .then(buildNewMembership)
    .then(insertNewMembership)
    .catch(function (error) {
        global.logger.error(error);
    });