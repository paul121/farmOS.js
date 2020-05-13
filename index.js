const axios = require('axios');
const compose = require('ramda/src/compose');
const {create} = require('simple-oauth2');

function farmOS(host, client_id='farmos_development', client_secret='') {
  const oauthCredentials = {
    client: {
      id: client_id,
      // Cannot be null. Most be empty string for encoding in Authorization header.
      secret: client_secret,
    },
    auth: {
      tokenHost: host,
      tokenPath: '/oauth2/token',
      revokePath: '/oauth2/revoke',
      authorizePath: '/oauth2/authorize',
    },
  }

  // Instantiate simple-oauth2 library with farmOS server OAuth credentials.
  const farmOAuth = create(oauthCredentials);

  // Helper function to get an OAuth access token.
  // This will attempt to refresh the token if needed.
  // Returns a Promise that resvoles as the access token.
  const getAccessToken = () => {
    if (farm.token == null) {
      throw new Error('client must be authorized before making requests.');
    }
    if (farm.token.expired()) {
      const params = {
        client_id,
        client_secret,
      };
      return farm.token.refresh(params)
        .then(accessToken => farm.useToken(accessToken.token).access_token)
        .catch((err) => { throw err; });
    }
    return Promise.resolve(farm.token.token.access_token);
  };

  // Helper function to get a CSRF token.
  // Returns a Promise that resolves as the token.
  const getCSRFToken = (accessToken) => {
    if (farm.csrfToken == null) {
      const opts = {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'json',
          Authorization: 'Bearer ' + accessToken,
        },
        withCredentials: true,
      };
      return axios(host + '/restws/session/token', opts)
      .then(res => { farm.csrfToken = res.data; return farm.csrfToken; })
      .catch((error) => { throw error; })
    }
    return Promise.resolve(farm.csrfToken);
  };

  function request(endpoint, {
    method = 'GET',
    payload = '',
  } = {}) {
    const url = host + endpoint;
    // Set basic axios options, for a non-auth GET requests
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'json',
      },
      withCredentials: true,
    };
    // Axios options for non-auth POST and PUT requests
    if (method === 'POST' || method === 'PUT') {
      opts.data = JSON.stringify(payload);
    }

    // Return a chain of promises.
    // First get an access token.
    return getAccessToken().then(accessToken => {
      opts.headers['Authorization'] = 'Bearer ' + accessToken;
      return accessToken
    })
    // Get the CSRF token.
    // An access Token is required to authenticate this request.
    .then(accessToken => getCSRFToken(accessToken))
    .then(csrfToken => {
      opts.headers['X-CSRF-Token'] = csrfToken;
      return axios(url, opts)
        .then((res) => {
          return res.data;
        }).catch((err) => { throw err; });
    })
  }

  // Recursive request for looping through multiple pages
  function requestAll(url, page = 0, list = []) {
    return request(`${url}&page=${page}`)
      .then((response) => {
        const lastPage = +(new URL(response.last)).searchParams.get('page');
        if (page === lastPage) {
          return { list: list.concat(response.list) };
        }
        const newList = list.concat(response.list);
        return requestAll(url, page + 1, newList);
      })
      .catch((err) => { throw err; });
  }

  // Utility for parsing if there's an ID provided, then formatting the params
  const params = id => (id ? `/${id}.json` : '.json');

  // Utility for finding the vid of the farm_assets vocabulary
  const areaVid = vocab => vocab.list
    .find(voc => voc.machine_name === 'farm_areas')
    .vid;

  // Utility for appending query params onto an endpoint
  const appendParam = (name, value) => endpoint => (
    (endpoint.endsWith('?') && value !== undefined) // eslint-disable-line no-nested-ternary
      ? `${endpoint}${name}=${value}`
      : (value !== undefined)
      ? `${endpoint}&${name}=${value}` // eslint-disable-line indent
      : endpoint // eslint-disable-line indent
  );

  // Utility for appending an array of query params onto an endpoint
  const appendArrayOfParams = (name, arr) => (endpoint) => {
    if (arr !== undefined) {
      return arr.reduce((acc, cur, i) => (
        appendParam(`${name}[${i}]`, cur)(acc)
      ), endpoint);
    }
    return endpoint;
  };

  // Run requests for arrays in batches, so not to exceed URL length of 2000 chars
  const batchRequest = (name, arr, endpoint, results = []) => {
    if (arr.length <= 100) {
      const query = appendArrayOfParams(name, arr)(endpoint);
      return request(query)
        .then(_res => ({ list: results.concat(_res.list) }))
        .catch((err) => { throw err; });
    }
    const thisBatch = arr.slice(0, 99);
    const nextBatch = arr.slice(99);
    const query = appendArrayOfParams(name, thisBatch)(endpoint);
    return request(query)
      .then(_res => batchRequest(name, nextBatch, endpoint, _res.list))
      .catch((err) => { throw err; });
  };

  const farm = {
    // Create a simple-oauth2 token object from existing token.
    useToken(token) {
      const newToken = farmOAuth.accessToken.create(token);
      farm.token = newToken;
      return farm.token.token;
    },
    authorize(user, password, scope = 'user_access') {
      // Try to authenticate with OAuth if scope is provided.
      if (user != null && password != null) {
        const tokenConfig = {
          username: user,
          password: password,
          scope,
        };
        return farmOAuth.ownerPassword.getToken(tokenConfig)
          .then((result) => farm.useToken(result))
            .then(token => token)
            .catch((error) => { throw error; })
          .catch((error) => { throw error; });
      }
    },
    logout() {
      if (farm.token != null) {
        return farm.token.revokeAll().then(farm.token = null);
      }
      return Promise.resolve();
    },
    token: null,
    csrfToken: null,
    area: {
      delete(id) {
        return request('/taxonomy_vocabulary.json').then(res => (
          request(`/taxonomy_term.json?vocabulary=${areaVid(res)}${params(id)}`, { method: 'DELETE' })
        ));
      },
      get(opts = {}) {
        return request('/taxonomy_vocabulary.json').then((res) => {
          // If an ID # is passed instead of an options object
          if (typeof opts === 'number') {
            return request(`/taxonomy_term.json?vocabulary=${areaVid(res)}&tid=${opts}`);
          }

          // If an option object is passed, set defaults and parse the string params
          const { page = null, type = '' } = opts;
          const typeParams = (type !== '') ? `area_type=${type}` : '';
          const pageParams = (page !== null) ? `page=${page}` : '';

          // If no page # is passed, get all of them
          if (page === null) {
            return requestAll(`/taxonomy_term.json?vocabulary=${areaVid(res)}&${typeParams}`);
          }

          // If no ID is passed but page is passed
          return request(`/taxonomy_term.json?vocabulary=${areaVid(res)}&${typeParams}&${pageParams}`);
        });
      },
      send(payload, id) {
        return request('/taxonomy_vocabulary.json').then(res => (
          request(`/taxonomy_term.json?vocabulary=${areaVid(res)}${params(id)}`, { method: 'POST', payload })
        ));
      },
    },
    asset: {
      delete(id) {
        return request(`/farm_asset/${id}.json`, { method: 'DELETE' });
      },
      get(opts = {}) {
        // If an ID # is passed instead of an options object
        if (typeof opts === 'number') {
          return request(`/farm_asset/${opts}.json`);
        }

        // If an option object is passed, set defaults and parse the string params
        const {
          type = '',
          archived = false,
          page = null,
        } = opts;
        const typeParams = (type !== '') ? `type=${type}` : '';
        const archiveParams = (archived) ? '' : '&archived=0';
        const pageParams = (page !== null) ? `&page=${page}` : '';

        // If no page # is passed, get all of them
        if (page === null) {
          return requestAll(`/farm_asset.json?${typeParams}${archiveParams}`);
        }

        // If no ID is passed but page is passed
        return request(`/farm_asset.json?${typeParams}${archiveParams}${pageParams}`);
      },
      send(payload, id) {
        return request(`/farm_asset${params(id)}`, { method: 'POST', payload });
      },
    },
    info() {
      // Returns a json with {name: , url: , user: {uid: , name: , mail: }}
      return request('/farm.json');
    },
    log: {
      delete(id) {
        return request(`/log/${id}.json`, { method: 'DELETE' });
      },
      get(opts = {}) {
        // If an ID # is passed instead of an options object
        if (typeof opts === 'number') {
          return request(`/log/${opts}.json`);
        }

        // If an array of id's are passed in
        if (Array.isArray(opts)) {
          return opts.length > 0
            ? batchRequest('id', opts, '/log.json?')
            : { list: [] };
        }

        const {
          page,
          type,
          log_owner, // eslint-disable-line camelcase
          done,
        } = opts;

        // Build the query string...
        const query = compose(
          appendParam('log_owner', log_owner),
          appendParam('done', done),
          appendArrayOfParams('type', type),
        )('/log.json?');

        // Append the page # if supplied and use paginated request...
        if (page !== undefined) {
          return compose(
            request,
            appendParam('page', page),
          )(query);
        }
        // Otherwise request all pages
        return requestAll(query);
      },
      send(payload) {
        if (payload.id) {
          return request(`/log/${payload.id}`, { method: 'PUT', payload })
            // Add properties back to response so it mirrors a POST response
            .then(res => ({
              ...res,
              id: payload.id,
              uri: `${host}/log/${payload.id}`,
              resource: 'log',
            }));
        }
        return request('/log', { method: 'POST', payload });
      },
    },
    term: {
      get(opts = {}) {
        // If a taxonomy machine name is passed in, just return the bundle
        if (typeof opts === 'string') {
          return requestAll(`/taxonomy_term.json?bundle=${opts}`);
        }

        const {
          page,
          vocabulary,
          name,
        } = opts;

        // Build the url and query params...
        const query = compose(
          appendParam('vocabulary', vocabulary),
          appendParam('name', name),
        )('/taxonomy_term.json?');

        // If no page param is given, request all pages for the given params
        if (page === undefined) {
          return requestAll(query);
        }

        // Otherwise submit the request with page parameters
        return compose(
          request,
          appendParam('page', page),
        )(query);
      },
      send(payload) {
        if (payload.tid) {
          return request(`/taxonomy_term/${payload.tid}`, { method: 'PUT', payload });
        }
        return request('/taxonomy_term', { method: 'POST', payload });
      },
    },
    vocabulary(machineName) {
      if (machineName === undefined) {
        return request('/taxonomy_vocabulary.json');
      }
      return request(`/taxonomy_vocabulary.json?machine_name=${machineName}`);
    },
  };
  return farm;
}

module.exports = farmOS;
