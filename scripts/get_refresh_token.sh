# Client id from Google Developer console
# Client Secret from Google Developer console
# Scope this is a space seprated list of the scopes of access you are requesting.

# Authorization link.  Place this in a browser and copy the code that is returned after you accept the scopes.


SCOPES="https://www.googleapis.com/auth/drive"

echo "https://accounts.google.com/o/oauth2/auth?client_id=$GOOGLE_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=$SCOPES&response_type=code"

# Exchange Authorization code for an access token and a refresh token.

# fullname="USER INPUT"
read -p "Enter access code: " access_code

curl \
--request POST \
--data "code=$access_code&client_id=$GOOGLE_CLIENT_ID&client_secret=$GOOGLE_CLIENT_SECRET&redirect_uri=urn:ietf:wg:oauth:2.0:oob&grant_type=authorization_code" https://accounts.google.com/o/oauth2/token