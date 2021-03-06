'use strict';
/*jshint esversion: 6, node:true */

const {google} = require('googleapis');
const fs = require('fs');
const uuid = require('uuid');
const {PassThrough} = require('stream');

var bucket_name = 'test-gator';

const PDF_ROOT = 'root';

const SYSFOLDER_ROOT = 'sysfolder';

const SYSTEM_FOLDERS = {
  'original' : 'All documents',
  'alphabetical' : 'Author'
};

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

let get_existing_root_folders = (root=PDF_ROOT) => {
  return get_folders_in(root).then( folders => {
    return folders;
  });
};

let get_existing_tags = async (root=PDF_ROOT) => {
  let root_folders = await get_folders_in(root);
  let simple_tags = root_folders.filter( folder => ! is_system_folder(folder) );
  let all_system_tags = [];
  for (const system_folder of root_folders.map( is_system_folder ).filter( folder => folder )) {
    let system_tags = await get_folders_in(system_folder.id);
    system_tags.forEach( child => {
      child.name =  `${SYSFOLDER_ROOT}/${system_folder.system}/${child.name}`;
    });
    all_system_tags = all_system_tags.concat( system_tags );
  }
  return simple_tags.concat( all_system_tags );
};

const is_system_folder = (folder) => {
  for (const [system_key, foldername] of Object.entries(SYSTEM_FOLDERS)) {
    if (folder.name == foldername) {
      return Object.assign({ system: system_key }, folder);
    }
  }
};

const create_tag_folder = (root=PDF_ROOT,tag,system_folders={}) => {
  if (tag.indexOf(SYSFOLDER_ROOT) == 0) {
    let [,sysid,syschild] = tag.split('/');
    root = system_folders[sysid].id;
    tag = syschild;
  }
  return create_folder(root,tag);
}


let ensure_tagset = async (tags,root=PDF_ROOT) => {
  let system_folders = await ensure_system_folders(root);
  let existing_tags = await get_existing_tags(root);
  let existing = existing_tags.map( tag => tag.name.toLowerCase() );
  console.log('Ensuring tags - existing tags for root',root,existing.length);
  return Promise.all( tags.map( tag => {
    let lc_tag = tag.toLowerCase();
    if (existing.indexOf(lc_tag) >= 0) {
      return Promise.resolve(existing_tags [ existing.indexOf( lc_tag ) ]);
    }
    return create_tag_folder(root,tag,system_folders).then( id => {
      console.log('Created tag',id);
      return { id: id, name: tag };
    });
  }));
};

const get_system_folders = async (root=PDF_ROOT) => {
  let folders = await get_existing_root_folders(root);
  let current_folders = {};
  for (const [system_key, foldername] of Object.entries(SYSTEM_FOLDERS)) {
    let existing_folders = folders.filter( folder => folder.name == foldername );
    if (existing_folders.length > 0) {
      current_folders[system_key] = existing_folders[0];
      continue;
    }
  }
  return current_folders;
};

const ensure_system_folders = async (root=PDF_ROOT) => {
  let folders = await get_existing_root_folders(root);
  let current_folders = {};
  for (const [system_key, foldername] of Object.entries(SYSTEM_FOLDERS)) {
    let existing_folders = folders.filter( folder => folder.name == foldername );
    if (existing_folders.length > 0) {
      current_folders[system_key] = existing_folders[0];
      continue;
    }
    let new_folder_id = await create_folder(root, foldername);
    current_folders[system_key] = {id: new_folder_id, name: foldername };
  }
  return current_folders;
};


function chunk (arr, len) {

  var chunks = [],
      i = 0,
      n = arr.length;

  while (i < n) {
    chunks.push(arr.slice(i, i += len));
  }

  return chunks;
}

let get_all_shortcuts = async (existing_tags=[],pageToken) => {
  const CHUNK_SIZE=20;
  if (existing_tags.length > CHUNK_SIZE) {
    let chunked_tags = [];
    let chunks = chunk(existing_tags,CHUNK_SIZE);
    for (let chunk of chunks) {
      chunked_tags = chunked_tags.concat( await get_all_shortcuts(chunk,pageToken) );
    }
    return chunked_tags.flat();
  }
  let parent_query = existing_tags.map( tag => `'${tag.id}' in parents` ).join(' or ');
  const service = google.drive('v3');
  return service.files.list({
    q: `mimeType='application/vnd.google-apps.shortcut' and shortcutDetails.targetMimeType = 'application/pdf' and (${parent_query})`,
    fields: 'nextPageToken,files(id,parents,shortcutDetails)',
    pageToken: pageToken
  }).then( resp => {
    let result = resp.data;
    let target_files = result.files.map( ({parents,shortcutDetails,id}) => {
      parents = parents.map( id => existing_tags.filter( tag => tag.id == id )[0] );
      let targetId = shortcutDetails.targetId;
      return {parents,targetId,id};
    });
    if (result.nextPageToken) {
      return get_all_shortcuts(existing_tags,result.nextPageToken).then( dat => target_files.concat( dat ) );
    } else {
      return target_files;
    }
  });
};

let get_name_for_file = (fileId) => {
  const service = google.drive('v3');

  return service.files.get({
    fileId: fileId,
    fields: 'name'
  }).then( resp => {
    return resp.data.name;
  });  
};

let match_filenames = (filename,tags) => {
  let filename_idx = filename.toLowerCase().substring(0,2) || "xx";

  return tags.filter( ({id,name}) => {
    if (name.indexOf(SYSFOLDER_ROOT) < 0) {
      return true;
    }
    if (name.indexOf(`${SYSFOLDER_ROOT}/alphabetical`) < 0) {
      return true;
    }
    if (name == `${SYSFOLDER_ROOT}/alphabetical/${filename_idx}`) {
      return true;
    }
  });
}

let get_shortcuts_for_file = async (fileId,roots=[PDF_ROOT]) => {
  const service = google.drive('v3');
  let root_ids = await find_roots_for_file(fileId,roots);

  let root = root_ids[0];

  if ( ! root ) {
    throw new Error('Cant find root for file');
  }

  let filename = await get_name_for_file(fileId);

  return get_existing_tags(root)
  .then( match_filenames.bind(null,filename) )
  .then( get_all_shortcuts )
  .then( (shortcuts) => {
    let shortcut_map = new Map();
    for (let {parents,targetId,id} of shortcuts) {
      if ( ! shortcut_map.get(targetId)) {
        shortcut_map.set(targetId,new Set());
      }
      for (let parent of parents) {
        shortcut_map.get(targetId).add({tag: parent, id });  
      }
    }
    if ( ! shortcut_map.get(fileId)) {
      shortcut_map.set(fileId,new Set());
    }
    return [{ root: root, shortcuts: shortcut_map.get(fileId) }];
  });
};

let possible_parent_folders = async (roots) => {
  let originals = await get_originals_folders(roots);
  return roots.map( (rootid,idx) => {
    let original = originals[idx];
    return {rootid, original};
  });
};

let find_roots_for_file = async (fileId,roots) => {
  const service = google.drive('v3');

  let possible_parents = await possible_parent_folders(roots);

  let parents = await service.files.get({
    fileId,
    fields: 'parents'
  }).then( resp => {
    return resp.data.parents;
  });
  let result = [];
  for (let parent of parents) {
    let matching_parent = possible_parents.filter( rootinfo => {
      let {rootid,original} = rootinfo;
      return (rootid == parent || original == parent)
    });
    if (matching_parent.length > 0) {
      result = result.concat(matching_parent);
    }
  }
  return result.filter((o,i,a) => a.indexOf(o) == i).map( root => root.rootid );
};

let get_tags_for_file = async (fileId,roots=[PDF_ROOT]) => {
  let results = [];
  let curr_roots = await find_roots_for_file(fileId,roots);
  let parents = await service.files.get({
    fileId,
    fields: 'parents'
  }).then( resp => {
    return resp.data.parents;
  });
  return Promise.all( curr_roots.map( root => {
    return get_existing_tags(root).then( tags => {
      let ids = tags.map( t => t.id );
      return { root: root, tags: parents.map( par => tags[ ids.indexOf( par ) ]).filter( t => t ) };
    });
  }) );
};

let create_shortcut_for_file = (fileId,tagid) => {
  const service = google.drive('v3');
  let shortcutMetadata = {
    'mimeType': 'application/vnd.google-apps.shortcut',
    'parents' : [tagid],
    'shortcutDetails': {
      'targetId': fileId
    }
  };
  return service.files.create({
    'resource': shortcutMetadata,
    'fields': 'id,name,mimeType,shortcutDetails'
  });

};

let remove_shortcut = (shortcut) => {
  const service = google.drive('v3');
  return service.files.delete({
    'fileId': shortcut.id
  });
};

const ensure_parent_for_file = async ( fileId,root=PDF_ROOT ) => {
  const service = google.drive('v3');
  let system_folders = await ensure_system_folders(root);
  console.log(system_folders);
  let original_folder = system_folders.original.id;
  let fileinfo = await service.files.get({fileId, fields: 'parents,capabilities'}).then( res => res.data );
  if ( ! fileinfo.capabilities.canMoveItemWithinDrive) {
    console.log('No permissions to set parent for this file');
    return;
  }
  if  (fileinfo.parents.indexOf(original_folder) >= 0) {
    return;
  }
  console.log('Moving',fileId,'to originals folder');
  let to_remove = fileinfo.parents.filter( folder => folder != original_folder ).join(',');
  let to_add = original_folder;
  return service.files.update({
    fileId,
    enforceSingleParent: true,
    addParents: to_add,
    removeParents: to_remove
  });
};

let set_shortcuts_for_file = async (fileId,tags,empty=['inbox'],roots=null) => {
  const service = google.drive('v3');

  if (! roots ) {
    return get_shared_folders().then( valid_roots => { return set_shortcuts_for_file(fileId,tags,empty,roots=Object.keys(valid_roots)) });
  }

  if (tags.length == 0) {
    tags = [].concat(empty);
  }

  let filename = await get_name_for_file(fileId);
  let filename_idx = filename.toLowerCase().substring(0,2) || "xx";
  const alphabetical_tag_prefix = `${SYSFOLDER_ROOT}/alphabetical`;
  tags = tags.filter( tag => tag.indexOf(alphabetical_tag_prefix) < 0 ).concat( `${alphabetical_tag_prefix}/${filename_idx}`)

  console.log('Getting tags for file ',fileId,'roots ',roots);
  let root_tagset = await get_shortcuts_for_file(fileId,roots);
  console.log(root_tagset);
  return Promise.all( root_tagset.map( async root_tag => {
    console.log(root_tag);
    let current_tags = [...root_tag.shortcuts].map( shortcut => shortcut.tag );
    let current_shortcuts = [...root_tag.shortcuts];
    let root = root_tag.root;

    await ensure_parent_for_file(fileId,root);

    console.log('Current tags are',current_tags.map( tag => tag.name ),'in root',root);
    tags = tags.flat();
    return ensure_tagset(tags,root).then( all_tags => {
      console.log('After ensuring tagset, relevant tags are',all_tags);
      let curr_ids = current_tags.map( t => t.id );
      let wanted_tags = all_tags.map( t => t.id );
      let to_add =  wanted_tags.filter( t => curr_ids.indexOf(t) < 0 );
      let to_remove = curr_ids.filter( t => wanted_tags.indexOf(t) < 0 ).map( id => current_shortcuts.filter( shortcut => shortcut.tag.id == id )[0] );
      if (to_add.length == 0 && to_remove.length == 0) {
        console.log('Not moving anything');
        return Promise.resolve();
      }
      console.log('Moving file shortcuts');
      console.log('To add:',to_add);
      console.log('To remove:',to_remove);
      return Promise.all([
        ...to_add.map( id => create_shortcut_for_file( fileId, id )),
        ...to_remove.map( shortcut => remove_shortcut(shortcut) )
      ])
    });
  }));
};

let set_tags_for_file = async (fileId,tags,empty=['inbox'],roots=null) => {
  const service = google.drive('v3');

  if (! roots ) {
    return get_shared_folders().then( valid_roots => { return set_tags_for_file(fileId,tags,empty,roots=Object.keys(valid_roots)) });
  }

  if (tags.length == 0) {
    tags = [].concat(empty);
  }

  console.log('Getting tags for file ',fileId,'roots ',roots);

  let root_tagset = await get_tags_for_file(fileId,roots);


  return Promise.all( root_tagset.map( async root_tag => {
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
      let max_chunk = 30 * 1024 * 1024;

      if (file.size >= max_chunk) {
        console.log('File size too large, increasing multipart size for MD5 check');
        params.ContentMD5 = new Buffer(file.md5 || '','hex').toString('base64');
        max_chunk = file.size + 1024*1024;
      } else {
        params.ContentMD5 = new Buffer(file.md5 || '','hex').toString('base64');
      }

      console.log('Using multipart part size of',max_chunk);

      var options = {partSize: max_chunk, queueSize: 1};
      return s3.upload(params, options).promise();
    }).catch( err => {
      if (err.code === 'BadDigest') {
        console.log('Bad MD5 sum');
        throw new Error('BadMD5');
        return;
      }
      if (err.code === 'InvalidDigest') {
        console.log('File too large for uploading, skipping');
        return;
      }
      if (err.code == 404) {
        console.log('File missing, skipping');
        return;
      }
      throw err;
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
  .then( results => {
    return results.files
    .filter( dir => dir.sharingUser )
    .map( dir => {
      return { name: dir.name, id: dir.id, user: dir.sharingUser.emailAddress };
    })
  })
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

const get_originals_folders = async (roots) => {
  return Promise.all( roots.map( async root => {
    let systems = await get_system_folders(root);
    if ( ! systems.original ) {
      return;
    }
    return systems.original.id;
  }));
};

const get_changed_files = (page_token,files=[],valid_roots=null) => {
  var service = google.drive('v3');

  if ( ! valid_roots ) {
    return get_shared_folders().then( async valid_roots => {
      let child_system_folders = await get_originals_folders(Object.keys(valid_roots));
      for (let child_original of child_system_folders.filter( folderid => folderid )) {
        valid_roots[child_original] = child_original;
      }
      return get_changed_files(page_token,files,valid_roots);
    });
  }

  if (page_token == 'none') {
    console.log('No page token already, getting a new one');
    return get_start_token().then(token => get_changed_files(token,files));
  }
  console.log('Looking for new files starting from ',page_token);
  return new Promise(function(resolve,reject) {
    service.changes.list({
      pageToken: page_token,
      fields: 'newStartPageToken, nextPageToken, changes(fileId, file/id, file/name, file/md5Checksum, file/parents, file/size)'
    },function(err,resp) {
      if (err) {
        reject(err);
        return;
      }
      let result = resp.data;
      result.changes = (result.changes || []).filter( file => file.file );
      console.log("Raw changes",JSON.stringify(result.changes.map(function(file) {
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
  return getServiceAuth().then( () => { return set_shortcuts_for_file(fileId,tags); });
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

exports.get_shared_folders = get_shared_folders;
exports.get_existing_tags = get_existing_tags;
exports.set_shortcuts_for_file = set_shortcuts_for_file;

exports.ensure_tagset = ensure_tagset;
exports.get_system_folders = get_system_folders;
exports.ensure_parent_for_file = ensure_parent_for_file;
exports.create_shortcut_for_file = create_shortcut_for_file;

