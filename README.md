# Reverse-Shell-Listener

reverse-shell-listener is Node.JS script that listens on port 1337 as a TCP server on which you can reply from WebUI. 

![Screenshot](https://raw.githubusercontent.com/nemanjan00/reverse-shell-listener/master/screenshot/screenshot.png)

## Getting Started 
Create a new new user for running this application. This should not be run as root.
```
useradd -s /bin/bash -m -d /home/safeuser -c "safe user" safeuser
passwd safeuser
usermod -aG sudo safeuser
```
Next, login as the new user you have just created to finish the installation.
```
sudo apt-get install nodejs
sudo ln -s "$(which nodejs)" /usr/bin/node
git clone https://github.com/nemanjan00/reverse-shell-listener.git
cd reverse-shell-listener/
sudo apt-get install npm
npm install
npm install pm2
sudo npm install pm2 -g
pm2 start server.js
```
Finally remove sudo from the application user to limit access if someone manages to compromise tha pplication. 
```
sudo deluser safeuser sudo
```