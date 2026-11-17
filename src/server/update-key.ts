// Public half of the key that signs the update feed (the private half never leaves the owner's Mac: .release-keys/).
// Replacing this key makes every installed app reject feeds signed with the old one: do not regenerate it per build.
export const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAOW4I0tLG9EE11tJIzDcIFJui8FB/bI/1FnsD9LYlhnI=';
