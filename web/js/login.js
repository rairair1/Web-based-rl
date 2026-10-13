// Shows the error message after a failed sign-in.
if (new URLSearchParams(location.search).has('error')) document.getElementById('error').hidden = false;
