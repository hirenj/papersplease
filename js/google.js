'use strict';
/*jshint esversion: 6, node:true */

const google = require('googleapis');
const fs = require('fs');
const uuid = require('uuid');

var bucket_name = 'test-gator';

var google_get_start_token = function(auth) {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    service.changes.getStartPageToken({'auth' : auth},function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      var startPageToken = result.startPageToken;
      resolve(startPageToken);
    });
  });
};

var google_request_hook = function(auth,hook_url,token) {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    service.changes.watch({'auth' : auth,
    pageToken: token,
    resource: {
      id: uuid.v1(),
      type: 'web_hook',
      address: hook_url
    }},function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      result.page_token = token;
      resolve(result);
    });
  });
};

var google_register_hook = function(auth,hook_url) {
  return google_get_start_token(auth).then(function(startPageToken) {
    return google_request_hook(auth,hook_url,startPageToken);
  });
};

var google_remove_hook = function(auth,hook_data) {
  var service = google.drive('v3');

  return new Promise(function(resolve,reject) {
    service.channels.stop({'auth' : auth, 
      resource: {
        kind: hook_data.kind,
        id: hook_data.id,
        resourceId: hook_data.resourceId,
        resourceUri: hook_data.resourceUri,
        type: 'web_hook',
        address: hook_data.address
      }},function(err,result) {
        if (err) {
          console.log("Got an error");
          console.log(err);
          console.log(err.code);
          if (err.code == 404) {
            console.log("Channel already removed at ",hook_data.id);
            resolve(true);
            return;
          }
          reject(err);
          return;
        }
        console.log("Successfully removed channel at ",hook_data.id);
        resolve(true);
      });
    });
};

var google_get_file_if_needed = function(auth,file) {
  return google_get_file_if_needed_s3(auth,file);
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

var google_get_file_if_needed_s3 = function(auth,file) {
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
    console.log("Trying upload to S3");
    var in_stream = drive.files.get({
      'auth' : auth,
      'fileId' : file.id ,
      'alt' : 'media'
    });
    var stream = new require('stream').PassThrough();
    in_stream.pipe(stream);
    params.Body = stream;
    params.ContentMD5 = new Buffer(file.md5,'hex').toString('base64');
    var options = {partSize: 15 * 1024 * 1024, queueSize: 1};
    return new Promise(function(resolve,reject) {
      s3.upload(params, options,function(err,data) {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  });
};

var google_get_file_if_needed_local = function(auth,file) {
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
        'auth' : auth,
        'fileId' : file.id ,
        'alt' : 'media'
      }).on('end',resolve).on('error',reject).pipe(dest);
    })
  });
};

const get_changed_files = (auth,page_token,files) => {
  var service = google.drive('v3');
  if ( ! files ) {
    files = [];
  }
  if (page_token == 'none') {
    return google_get_start_token(auth).then(function(token) {
      return google_get_changed_files(auth,token,files);
    });
  }
  return new Promise(function(resolve,reject) {
    service.changes.list({'auth' : auth, pageToken: page_token },function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      console.log("Changes",JSON.stringify(result.changes.map(function(file) {
        return { id: file.fileId, removed: file.removed, name : file.file.name };
      })));
      var current_files = result.changes.filter(function(file) {
        return ! file.removed && file.file.name.match(/msdata/);
      }).map(function(file) {
        return file.fileId;
      });
      if (result.nextPageToken) {
        resolve(google_get_changed_files(auth,result.nextPageToken,files.concat(current_files)));
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
  var scopes = ["https://www.googleapis.com/auth/drive.readonly"];
  return getServiceAuth(scopes).then( (auth) => get_changed_files(auth,page_token) );
};

var registerHook = function registerHook(hook_url) {
  var scopes = ["https://www.googleapis.com/auth/drive.readonly"];
  return getServiceAuth(scopes).then(function(auth) {
    return google_register_hook(auth,hook_url);
  });
};

var removeHook = function removeHook(hook_data) {
  var scopes = ["https://www.googleapis.com/auth/drive.readonly"];
  return getServiceAuth(scopes).then(function(auth) {
    return google_remove_hook(auth,hook_data);
  });
};

var downloadFileIfNecessary = function downloadFileIfNecessary(file) {
  var scopes = ["https://www.googleapis.com/auth/drive.readonly"];
  if (file.auth_token && file.auth_token.access_token) {
    console.log("We have an Auth token, trying to access directly");
    var auth_client = new google.auth.OAuth2();
    auth_client.credentials = file.auth_token;
    delete file.auth_token.refresh_token;
    return google_get_file_if_needed(auth_client,file);
  }
  console.log("We have no auth token, trying to get a fresh auth");
  return getServiceAuth(scopes).then(function(auth) {
    return google_get_file_if_needed(auth,file);
  });
};

var auth_promise;

var getServiceAuth = function getServiceAuth(scopes,force) {
  if (auth_promise && ! force) {
    console.log("Returning cached permissions");
    return auth_promise;
  }
  auth_promise = require('lambda-helpers').secrets.getSecret(bucket_name).then(function(secret) {
    return get_service_auth(secret,scopes);
  });
  return auth_promise;
};

exports.setRootBucket = function(bucket) {
  bucket_name = bucket;
};
exports.registerHook = registerHook;
exports.removeHook = removeHook;
exports.downloadFileIfNecessary = downloadFileIfNecessary;
exports.getFiles = getFiles;
exports.getChangedFiles = getChangedFiles;
exports.getServiceAuth = getServiceAuth;
exports.getGroups = getGroups;