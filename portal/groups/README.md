# Scripts for interacting with Red Hat Customer Portal
## Setup

These scripts are written in nodejs.  You will need to have `node` and `npm` installed.

1. Inside this directory install all the node modules `npm install`
2. _Optional:_ Install [Bunyan](https://github.com/trentm/node-bunyan) globally `npm -g install bunyan` to help view logs.
3. Copy the `credentials.example.js` to `credentials.js` and fill in the information.

## addAllUsersToAllGroups.js
This script will fetch all of the users from inside an account and add all users to all groups under that account.  This is really only useful for accounts enabling ACLs that then want to keep the current access model for existing users.  This will **NOT** make it so that new users are added to groups but simply migrates existing users.

```bash
node addAllUsersToAllGroups.js | bunyan
```