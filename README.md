# An organising web-app for PDFs

Applications that are great at organising folders are often terrible at annotating PDFs,
and apps that are great at annotating PDFs are often terrible at organising files. This
application aims to bridge that gap.

To ensure that your folder of PDFs remains neatly organised into tagged sub-folders,
you simply share your PDF folder with a Google Drive user/bot that this application is
linked to. The bot will watch your PDF folder, and whenever you change a PDF, it will
grab the updated annotations for that PDF, and then place the PDFs in folders so that
tags on the PDF match the folders that they are found in, taking advantage of the 
symlink-type functionality found in Google Drive.

To install this app, you need an AWS account that can create resources via a
CloudFormation template, and then you need to create API keys for Google Drive
for an application. Finally, you need to obtain a refresh token for the bot-user
that will be accepting shared folder requests

## Usage

To add a new user to the configuration, firstly share the PDF folder with the
bot-user, and then update the ```VALID_USERS``` parameter in the
cloudformation template. Ordering is important here, as you need to "restart"
the application whenever the set of shared folders changes (which you can also
do by making sure there are no running lambdas).
