'use strict';
/*jshint esversion: 6, node:true */

const {google} = require('googleapis');
const fs = require('fs');
const uuid = require('uuid');
const {PassThrough} = require('stream');

var bucket_name = 'test-gator';

const PDF_ROOT = 'root';

let get_folders_in = function(parent='root',pageToken) {
  const service = google.drive('v3');
  return service.files.list({
    q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'nextPageToken, files(id, name)',
    spaces: 'drive',
    pageToken: pageToken
  }).then( resp => {
    let result = resp.data;
    if (result.nextPageToken) {
      return get_folders_in(parent,result.nextPageToken).then( dat => result.files.concat( dat ) );
    }
    return result.files;
  });
};

let create_folder = function(parent='root',foldername) {
  const service = google.drive('v3');
  let meta = {
    'name': foldername,
    'parents': [parent],
    'mimeType': 'application/vnd.google-apps.folder'
  };
  return service.files.create({ resource: meta, fields: 'id' }).then( resp => {
    return resp.data.id;
  });
};

let get_existing_tags = (root=PDF_ROOT) => {
  return get_folders_in(root).then( folders => {
    return folders;
  });
};

let ensure_tagset = (tags,root=PDF_ROOT) => {
  return get_existing_tags(root).then( existing_tags => {
    let existing = existing_tags.map( tag => tag.name.toLowerCase() );
    console.log('Ensuring tags - existing tags for root',root,existing);
    return Promise.all( tags.map( tag => {
      let lc_tag = tag.toLowerCase();
      if (existing.indexOf(lc_tag) >= 0) {
        return Promise.resolve(existing_tags [ existing.indexOf( lc_tag ) ]);
      }
      return create_folder(root,tag).then( id => {
        return { id: id, name: tag };
      });
    }));
  });
};

let get_tags_for_file = (fileId,roots=[PDF_ROOT]) => {
  const service = google.drive('v3');
  return service.files.get({
    fileId: fileId,
    fields: 'parents'
  }).then( resp => {
    return resp.data.parents;
  }).then( parents => {
    let results = [];
    let curr_roots = roots.filter( root => parents.indexOf(root) >= 0 );
    return Promise.all( curr_roots.map( root => {
      return get_existing_tags(root).then( tags => {
        let ids = tags.map( t => t.id );
        return { root: root, tags: parents.map( par => tags[ ids.indexOf( par ) ]).filter( t => t ) };
      });
    }) );
  });
};


let set_tags_for_file = (fileId,tags,empty=['inbox'],roots=null) => {
  const service = google.drive('v3');

  if (! roots ) {
    return get_shared_folders().then( valid_roots => { return set_tags_for_file(fileId,tags,empty,roots=Object.keys(valid_roots)) });
  }

  if (tags.length == 0) {
    tags = [].concat(empty);
  }

  console.log('Getting tags for file ',fileId,'roots ',roots);
  return get_tags_for_file(fileId,roots).then( root_tagset => {
    return Promise.all( root_tagset.map( root_tag => {
      let current_tags = root_tag.tags;
      let root = root_tag.root;
      console.log('Current tags are',current_tags,'in root',root);
      return ensure_tagset(tags,root).then( all_tags => {
        console.log('available tags are',all_tags);
        let curr_ids = current_tags.map( t => t.id );
        let wanted_tags = all_tags.map( t => t.id );
        let to_add = wanted_tags.filter( t => curr_ids.indexOf(t) < 0 ).join(',');
        let to_remove = curr_ids.filter( t => wanted_tags.indexOf(t) < 0 ).join(',');
        if (to_add === '' && to_remove === '') {
          console.log('Not moving anything');
          return Promise.resolve();
        }
        console.log('Moving file');
        return service.files.update({
          fileId: fileId,
          addParents: to_add,
          removeParents: to_remove
        });
      });
    }));

  });
};

var get_start_token = function() {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    service.changes.getStartPageToken({},function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      let startPageToken = result.data.startPageToken;
      resolve(startPageToken);
    });
  });
};

var request_hook = function(hook_url,token) {
  var service = google.drive('v3');
  return service.changes.watch({
    pageToken: token,
    resource: {
      id: uuid.v1(),
      type: 'web_hook',
      address: hook_url
    }})
  .then( resp => resp.data );
};

var remove_hook = function(conf) {
  if ( ! conf.id ) {
    return Promise.resolve();
  }
  var service = google.drive('v3');
  return service.channels.stop({
  resource: {
    kind: conf.kind,
    id: conf.id,
    resourceId: conf.resourceId,
    resourceUri: conf.resourceUri,
    type: 'web_hook',
    address: conf.address
  }});
}

var register_hook = function(hook_url,token) {
  if (token === 'none') {
    return get_start_token().then( tok => register_hook(hook_url,tok.page_token) );
  }
  return request_hook(hook_url,token);
};

var get_file_if_needed = function(file) {
  return get_file_if_needed_s3(file);
}

var check_existing_file_s3 = function(file) {
  var AWS = require('lambda-helpers').AWS;
  var s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'uploads/google-' +file.id,
    IfNoneMatch: '"'+file.md5+'"'
  };
  return new Promise(function(resolve,reject) {
    s3.headObject(params, function(err, data) {
      if (err) {

        if (err.statusCode >= 500) {
          reject(err);
          return;
        }

        if (err.statusCode == 304) {
          console.log("Already uploaded");
          resolve(true);
          return;
        }
        if (err.statusCode == 403) {
          console.log("File doesn't exist");
          resolve(file);
          return;
        }
        if (err.statusCode == 404) {
          console.log("No file, need to upload");
          resolve(file);
          return;
        }
        reject(err);
        return;
      } else {
        resolve(file);
      }
    });
  });
};

var get_file_if_needed_s3 = function(file) {
  var drive = google.drive('v3');
  console.log("Getting file from google",file.id," md5 ",file.md5);
  return check_existing_file_s3(file).then(function(exists) {
    if (exists === true) {
      return true;
    }
    var AWS = require('lambda-helpers').AWS;
    var s3 = new AWS.S3();

    var params = {
      Bucket: bucket_name,
      Key: 'uploads/google-' +file.id
    };
    console.log("Trying upload to S3",params);

    let stream = new PassThrough();

    return drive.files.get({
      'fileId' : file.id ,
      'alt' : 'media'
    }, {responseType: 'stream'}).then( res => {
      res.data.pipe(stream);
      params.Body = stream;
      params.ContentMD5 = new Buffer(file.md5 || '','hex').toString('base64');
      var options = {partSize: 25 * 1024 * 1024, queueSize: 1};
      return s3.upload(params, options).promise();
    });
  });
};

var get_file_if_needed_local = function(file) {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    fs.lstat(file.id+'.msdata.json',function(err,stats) {
      if (! err) {
        // Skip checking MD5
        return resolve(true);
      }
      console.log("Downloading "+file.name,file.id);
      var dest = fs.createWriteStream(file.id+'.msdata.json');

      service.files.get({
        'fileId' : file.id,
        'alt' : 'media'
      }).on('end',resolve).on('error',reject).pipe(dest);
    })
  });
};

const VALID_USERS = (process.env.VALID_USERS || '').toLowerCase().split(',');

let shared_folder_promise = null;

let get_shared_folders = () => {
  const service = google.drive('v3');
  if ( shared_folder_promise ) {
    return shared_folder_promise;
  }

  shared_folder_promise = service.files.list({
    q: 'sharedWithMe and mimeType = \'application/vnd.google-apps.folder\'',
    fields: 'files(name,id,sharingUser/emailAddress)'
  })
  .then( resp => resp.data )
  .then( results => results.files.map( dir => {
    return { name: dir.name, id: dir.id, user: dir.sharingUser.emailAddress };
  }))
  .then( dirs => dirs.filter( dir => VALID_USERS.indexOf(dir.user.toLowerCase()) >= 0 ))
  .then( dirs => {
    let result = {};
    for (let dir of dirs) {
      result[ dir.id ] = dir;
    }
    return result;
  });

  return shared_folder_promise;

};

const get_changed_files = (page_token,files=[],valid_roots=null) => {
  var service = google.drive('v3');

  if ( ! valid_roots ) {
    return get_shared_folders().then( valid_roots => get_changed_files(page_token,files,valid_roots));
  }

  if (page_token == 'none') {
    console.log('No page token already, getting a new one');
    return get_start_token().then(token => get_changed_files(token,files));
  }
  console.log('Looking for new files starting from ',page_token);
  return new Promise(function(resolve,reject) {
    service.changes.list({
      pageToken: page_token,
      fields: 'newStartPageToken, nextPageToken, changes(fileId, file/id, file/name, file/md5Checksum, file/parents)'
    },function(err,resp) {
      if (err) {
        reject(err);
        return;
      }
      let result = resp.data;
      result.changes = (result.changes || []).filter( file => file.file );
      console.log("Changes",JSON.stringify(result.changes.map(function(file) {
        return { id: file.fileId, removed: file.removed, name : file.file.name, md5Checksum: file.file.md5Checksum };
      })));
      var current_files = result.changes.filter(function(file) {
        console.log(file);
        return ! file.removed && file.file.parents && (file.file.name || '').match(/\.pdf$/) && file.file.parents.filter( par => valid_roots[par] ).length > 0;
      }).map(function(file) {
        return file.file;
      });
      if (result.nextPageToken) {
        resolve(get_changed_files(result.nextPageToken,files.concat(current_files),valid_roots));
        return;
      }
      if (result.newStartPageToken) {
        console.log("New start page token should be ",result.newStartPageToken);
        // Update the triggers with the new start page token
        resolve({ files: files.concat(current_files), token: result.newStartPageToken });
      }
    });
  });
};


var getChangedFiles = function getChangedFiles(page_token) {
  return getServiceAuth()
  .then( () => get_changed_files(page_token) );
};

var registerHook = function registerHook(hook_url,token) {
  return getServiceAuth().then( () => register_hook(hook_url,token) );
};

let stopHook = function stopHook(conf) {
  return getServiceAuth().then( () => remove_hook(conf) );
}

var downloadFileIfNecessary = function downloadFileIfNecessary(file) {
  console.log("We have no auth token, trying to get a fresh auth");
  return getServiceAuth().then( () => get_file_if_needed(file) );
};

var setTagsForFileId = function setTagsForFileId(fileId,tags) {
  return getServiceAuth().then( () => { return set_tags_for_file(fileId,tags); });
};

var getServiceAuth = function getServiceAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  // set auth as a global default
  google.options({
    auth: oauth2Client
  });
  return Promise.resolve();
};


exports.setRootBucket = function(bucket) {
  bucket_name = bucket;
};

exports.registerHook = registerHook;
exports.stopHook = stopHook;
exports.downloadFileIfNecessary = downloadFileIfNecessary;
exports.getChangedFiles = getChangedFiles;
exports.setTagsForFileId = setTagsForFileId;
exports.getServiceAuth = getServiceAuth;