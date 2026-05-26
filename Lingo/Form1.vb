Imports TwitchLib.Client
Imports TwitchLib.Client.Enums
Imports TwitchLib.Client.Events
Imports TwitchLib.Client.Extensions
Imports TwitchLib.Client.Models
Imports TwitchLib.Communication.Events
Imports TwitchLib.Api
Imports System.Drawing.Drawing2D
Imports Microsoft.VisualBasic.FileIO
Imports System.Text
Imports System.Timers
Imports System.Runtime.Serialization
Imports System.Runtime.Serialization.Formatters.Binary
Imports System.IO
Imports System.ComponentModel
Imports System.Reflection
Imports System.Collections
Imports System.Linq
Imports System.Text.RegularExpressions
Imports Google.Cloud.Firestore

Public Class Form1
    ' REVERT: set UseWebFormOnly = False to restore whisper guesses/signup/feedback.
    Private Const UseWebFormOnly As Boolean = True
    ' Optional URL included in Twitch chat announcements (web-only mode).
    Private Const LingoWebUrl As String = "https://lingo.liquidkourage.com"

    Public g As Graphics
    Public client As TwitchClient
    Public wordlist1, wordlist2 As List(Of String)
    Public gamemode As GameModes
    Dim gametimer As Timer
    Dim gametime As Integer
    Dim scoringcompleted As Boolean
    Friend wordlist As New List(Of String)
    Public players As New List(Of Player)
    Public numballs As Integer = 0
    Public roundnum As Integer = 0
    Public ballmultiplier As Integer = 1
    Private channel As String
    Private firestoreListener As FirestoreExample
    Private ReadOnly processedWebGuesses As New HashSet(Of String)(StringComparer.OrdinalIgnoreCase)
    Friend answerRevealed As Boolean = False
    Private bingoOverlayActive As Boolean = False
    Private bingoLastCall As String = ""
    Private bingoRecentCalls As New List(Of String)
    Private bingoHostForm As BingoHostForm

    Enum GameModes
        registration
        guessing
        waiting
        results
    End Enum
    Private Sub Form1_Load(sender As Object, e As EventArgs) Handles Me.Load
        ballmultiplier = 1
        Dim credPath As String = ExtractResourceToFile("Lingo.liquidkourage-16fe5-43e37d656052.json")
        Environment.SetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS", credPath)

        channel = GetConfiguredTwitchChannel()
        If String.IsNullOrEmpty(channel) Then
            channel = InputBox("What is the name of your channel?  Omit the 'twitch.tv/' part.")
            My.Settings.channel = channel
            My.Settings.twitch_channel = channel
            My.Settings.Save()
        Else
            If String.IsNullOrWhiteSpace(My.Settings.channel) Then
                My.Settings.channel = channel
                My.Settings.Save()
            End If
        End If

        gametimer = New Timer(1000)
        AddHandler gametimer.Elapsed, New ElapsedEventHandler(AddressOf GameTimer_Tick)
        wordlist = My.Resources.LingoWords.Split(vbCrLf.ToCharArray, StringSplitOptions.RemoveEmptyEntries).ToList
        Dim r As New Random
        For i As Integer = 0 To 999
            ListBox1.Items.Add(wordlist(r.Next(wordlist.Count - 1)))
        Next

        Dim credentials As New ConnectionCredentials(GetConfiguredBotUsername(), GetConfiguredBotOauth(), "wss://irc-ws.chat.twitch.tv:443")
        client = New TwitchClient()
        client.Initialize(credentials, channel)
        AttachTwitchClientHandlers()
        Try
            client.Connect()
        Catch
            MsgBox("Can't connect.  Close and try again.")
            Me.Invoke(Sub() dumpdata())
            Me.Invoke(Sub() Me.Close())
        End Try

        Dim screenIndex As Integer = 0
        If My.Settings.screennumber = -1 Then
            screenIndex = CInt(InputBox("Which monitor should the public display use?  Typically, 0 is your 'main' display and 1,2,etc. are additional displays.  It is recommended to have the public display set up on a separate monitor from your main one."))
            My.Settings.screennumber = screenIndex
            My.Settings.Save()
        Else
            screenIndex = My.Settings.screennumber
        End If
        PublicDisplay.Location = Screen.AllScreens(screenIndex).Bounds.Location
        PublicDisplay.Size = Screen.AllScreens(screenIndex).Bounds.Size
        PublicDisplay.Show()

        firestoreListener = New FirestoreExample(Me)

        If BingoFeature.Enabled Then
            Button10.Visible = True
        Else
            Button10.Visible = False
        End If
    End Sub

    Public Sub SetBingoOverlay(lastCall As String, recentCalls As List(Of String))
        bingoOverlayActive = Not String.IsNullOrEmpty(lastCall)
        bingoLastCall = If(lastCall, "")
        bingoRecentCalls = If(recentCalls Is Nothing, New List(Of String)(), New List(Of String)(recentCalls))
        DrawBingoOverlay()
    End Sub

    Public Sub ClearBingoOverlay()
        bingoOverlayActive = False
        bingoLastCall = ""
        bingoRecentCalls.Clear()
        drawalluserresults()
    End Sub

    Private Sub DrawBingoOverlay()
        Using g As Graphics = PublicDisplay.PictureBox1.CreateGraphics()
            g.DrawImage(My.Resources.lingobg11, 0, 0, 1920, 1080)
            Using sf As New StringFormat With {.Alignment = StringAlignment.Center}
                Using f As New FontFamily("Arial")
                    Dim titlePath As New GraphicsPath()
                    titlePath.AddString("BINGO", f, FontStyle.Bold, 96, New Rectangle(0, 40, 1920, 120), sf)
                    g.FillPath(Brushes.Gold, titlePath)
                    g.DrawPath(Pens.Black, titlePath)

                    Dim callPath As New GraphicsPath()
                    Dim callText = If(String.IsNullOrEmpty(bingoLastCall), "—", bingoLastCall)
                    callPath.AddString(callText, f, FontStyle.Bold, 180, New Rectangle(0, 320, 1920, 220), sf)
                    g.FillPath(Brushes.White, callPath)
                    g.DrawPath(Pens.Black, callPath)

                    Dim historyY = 600
                    For i As Integer = 0 To Math.Min(bingoRecentCalls.Count - 1, 11)
                        Dim label = bingoRecentCalls(bingoRecentCalls.Count - 1 - i)
                        Dim hp As New GraphicsPath()
                        hp.AddString(label, f, FontStyle.Regular, 48, New Rectangle(0, historyY + i * 56, 1920, 50), sf)
                        g.DrawPath(Pens.White, hp)
                    Next
                End Using
            End Using
        End Using
        Using g As Graphics = PublicDisplay.PictureBox2.CreateGraphics
            g.DrawImage(My.Resources.hack2, 0, 0)
        End Using
    End Sub

    Private Sub AttachTwitchClientHandlers()
        AddHandler client.OnJoinedChannel, AddressOf OnJoinedChannel
        AddHandler client.OnMessageReceived, AddressOf OnMessageReceived
        If Not UseWebFormOnly Then
            AddHandler client.OnWhisperReceived, AddressOf OnWhisperReceived
        End If
        AddHandler client.OnConnected, AddressOf Client_OnConnected
        AddHandler client.OnDisconnected, AddressOf Client_OnDisconnected
        AddHandler client.OnReconnected, AddressOf Client_OnReconnected
        AddHandler client.OnLeftChannel, AddressOf Client_onLeftChannel
        AddHandler client.OnError, AddressOf Client_onError
    End Sub

    Private Function WebSiteLabel() As String
        If Not String.IsNullOrWhiteSpace(LingoWebUrl) Then Return LingoWebUrl
        Return "the Lingo website"
    End Function

    Private Function WebGuessInstructions() As String
        Return "Submit your guess at " + WebSiteLabel() + " (use your exact Twitch username)."
    End Function

    Private Function GetConfiguredTwitchChannel() As String
        If Not String.IsNullOrWhiteSpace(My.Settings.twitch_channel) Then Return My.Settings.twitch_channel
        Return My.Settings.channel
    End Function

    Private Function GetConfiguredBotUsername() As String
        If Not String.IsNullOrWhiteSpace(My.Settings.twitch_username) Then Return My.Settings.twitch_username
        Return "kouragethecowardlybot"
    End Function

    Private Function GetConfiguredBotOauth() As String
        If Not String.IsNullOrWhiteSpace(My.Settings.twitch_oauth) Then Return My.Settings.twitch_oauth
        Return "mui2jnpzbi4ne7uohndwz5j0scbpym"
    End Function

    Private Function LiveSignupChatMessage() As String
        If UseWebFormOnly Then
            Return "Lingo is LIVE! Type !in in chat to join (or sign up on " + WebSiteLabel() + "). Guesses are submitted on the website only — match your Twitch username exactly."
        End If
        Return "Lingo is LIVE!  To sign up: Using either the Twitch chat or a whisper to KourageTheCowardlyBot, type the word '!in'!"
    End Function

    Private Function ExtractResourceToFile(resourceName As String) As String
        Dim stream As Stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
        If stream Is Nothing Then Throw New Exception("Resource not found: " + resourceName)
        Dim tempFile As String = Path.GetTempFileName()
        Using outStream As New FileStream(tempFile, FileMode.Create, FileAccess.Write)
            stream.CopyTo(outStream)
        End Using
        Return tempFile
    End Function

    Friend Sub SetFirestoreStatus(message As String)
        If Me.IsHandleCreated AndAlso TextBox3 IsNot Nothing Then
            If Me.InvokeRequired Then
                Me.Invoke(Sub() TextBox3.Text = message)
            Else
                TextBox3.Text = message
            End If
        End If
        Debug.WriteLine(message)
    End Sub

    Public Sub ProcessUserGameChanges(previousSnapshot As QuerySnapshot, currentSnapshot As QuerySnapshot)
        Dim previousDocs = previousSnapshot.Documents.ToDictionary(Function(doc) doc.Id)
        Dim currentDocs = currentSnapshot.Documents.ToDictionary(Function(doc) doc.Id)

        For Each doc In currentSnapshot.Documents
            If Not previousDocs.ContainsKey(doc.Id) Then
                ProcessUserGameDocument(doc, "Added")
            ElseIf Not doc.Equals(previousDocs(doc.Id)) Then
                ProcessUserGameDocument(doc, "Modified")
            End If
        Next

        For Each doc In previousSnapshot.Documents
            If Not currentDocs.ContainsKey(doc.Id) Then
                ProcessUserGameDocument(doc, "Removed")
            End If
        Next
    End Sub

    Public Sub ProcessSubmissionChanges(previousSnapshot As QuerySnapshot, currentSnapshot As QuerySnapshot)
        Dim previousDocs = previousSnapshot.Documents.ToDictionary(Function(doc) doc.Id)
        For Each doc In currentSnapshot.Documents
            If Not previousDocs.ContainsKey(doc.Id) Then
                ProcessSubmissionDocument(doc)
            End If
        Next
    End Sub

    Private Sub ProcessSubmissionDocument(document As DocumentSnapshot)
        If Not document.Exists Then Return
        Try
            Dim displayName As String = document.GetValue(Of String)("display_name")
            Dim response As String = document.GetValue(Of String)("response")
            QueueWebGuess(displayName, response)
        Catch ex As Exception
            SetFirestoreStatus("Submission parse: " + ex.Message)
        End Try
    End Sub

    Private Sub ProcessUserGameDocument(document As DocumentSnapshot, changeType As String)
        If Not document.Exists Then Return

        Dim displayName As String = ""
        Try
            displayName = document.GetValue(Of String)("display_name")
        Catch
            Return
        End Try

        Dim lastResponse As String = GetLastResponseFromDocument(document)
        Dim playerExists As Boolean = players.Any(Function(p) String.Equals(p.Name, displayName, StringComparison.OrdinalIgnoreCase))

        If changeType = "Removed" AndAlso playerExists Then
            unregisterplayer(displayName)
            Return
        End If

        If changeType = "Added" Then
            If Not playerExists Then registerplayer(displayName)
            QueueWebGuess(displayName, lastResponse)
            Return
        End If

        If changeType = "Modified" Then
            If Not playerExists Then registerplayer(displayName)
            QueueWebGuess(displayName, lastResponse)
        End If
    End Sub

    Private Function ResponseFromAnswerEntry(entry As Object) As String
        If entry Is Nothing Then Return ""
        If TypeOf entry Is Dictionary(Of String, Object) Then
            Dim dict = DirectCast(entry, Dictionary(Of String, Object))
            If dict.ContainsKey("response") AndAlso dict("response") IsNot Nothing Then
                Return dict("response").ToString()
            End If
        ElseIf TypeOf entry Is IDictionary Then
            Dim dict = DirectCast(entry, IDictionary)
            If dict.Contains("response") AndAlso dict("response") IsNot Nothing Then
                Return dict("response").ToString()
            End If
        End If
        Return ""
    End Function

    Private Function GetLastResponseFromDocument(document As DocumentSnapshot) As String
        Try
            If Not document.ContainsField("answers") Then Return ""

            Try
                Dim answers = document.GetValue(Of List(Of Dictionary(Of String, Object)))("answers")
                If answers IsNot Nothing AndAlso answers.Count > 0 Then
                    Return ResponseFromAnswerEntry(answers(answers.Count - 1))
                End If
            Catch
            End Try

            Dim answersObj = document.GetValue(Of Object)("answers")
            If answersObj Is Nothing Then Return ""

            If TypeOf answersObj Is IEnumerable AndAlso Not TypeOf answersObj Is String Then
                Dim entries = DirectCast(answersObj, IEnumerable).Cast(Of Object)().ToList()
                If entries.Count > 0 Then
                    Return ResponseFromAnswerEntry(entries(entries.Count - 1))
                End If
            End If
        Catch ex As Exception
            SetFirestoreStatus("Answer parse: " + ex.Message)
        End Try
        Return ""
    End Function

    Private Sub QueueWebGuess(displayName As String, response As String)
        If String.IsNullOrWhiteSpace(displayName) OrElse String.IsNullOrWhiteSpace(response) Then Return

        Dim guessKey As String = displayName.Trim() + "|" + response.Trim().ToUpperInvariant()
        If processedWebGuesses.Contains(guessKey) Then Return
        processedWebGuesses.Add(guessKey)

        ApplyWebGuess(displayName.Trim(), response.Trim().ToUpperInvariant())
    End Sub

    Private Sub ApplyWebGuess(displayName As String, response As String)
        Dim playerExists As Boolean = players.Exists(Function(p) String.Equals(p.Name, displayName, StringComparison.OrdinalIgnoreCase))
        If Not playerExists Then registerplayer(displayName)

        If gamemode <> GameModes.guessing OrElse roundnum <= 0 Then
            updateplayernotes(displayName, response)
            Return
        End If

        If Regex.IsMatch(response, "^[A-Za-z]{5}$") Then
            updateplayerguess(displayName, response)
            lockinplayerguess(displayName)
            Dim stillwaiting As Boolean = False
            For Each p As Player In players
                If roundnum > 0 Then
                    If (String.IsNullOrEmpty(p.guess) AndAlso p.roundresult(roundnum - 1) < 1) OrElse p.guess = "@@@@@" Then stillwaiting = True
                End If
            Next
            If Not stillwaiting Then Button1.PerformClick()
        Else
            updateplayernotes(displayName, response)
        End If
    End Sub

    Private Sub Client_onError(sender As Object, e As OnErrorEventArgs)
        Debug.WriteLine(e.Exception.Message)
    End Sub

    Private Sub Client_onLeftChannel(sender As Object, e As OnLeftChannelArgs)
        Me.Invoke(Sub() TextBox3.Text = "Left Channel")
    End Sub

    Private Sub Client_OnConnected(ByVal sender As Object, ByVal e As OnConnectedArgs)
        Debug.WriteLine($"Connected to {e.AutoJoinChannel}")
        Me.Invoke(Sub() TextBox2.Text = "Connected")
        Debug.WriteLine("Connected")
    End Sub
    Private Sub Client_OnReconnected(ByVal sender As Object, ByVal e As OnReconnectedEventArgs)
        Me.Invoke(Sub() TextBox2.Text = "Reconnected")
        Debug.WriteLine("Reconnected")
    End Sub
    Private Sub Client_OnDisconnected(ByVal sender As Object, ByVal e As OnDisconnectedEventArgs)
        Me.Invoke(Sub() TextBox2.Text = "Disconnected")
        Debug.WriteLine("Disconnected")
        Dim credentials As New ConnectionCredentials(GetConfiguredBotUsername(), GetConfiguredBotOauth())
        'Dim credentials As New ConnectionCredentials("liquid_kourage", "j1kiijo0ymyef61xq6nbvr9jsw7f7i")
        client = New TwitchClient()
        client.Initialize(credentials, channel)
        AttachTwitchClientHandlers()
        Try
            client.Connect()
        Catch
            MsgBox("Can't connect.  Close and try again.")
            Me.Invoke(Sub() dumpdata())
            Me.Invoke(Sub() Me.Close())
        End Try
    End Sub

    Private Sub dumpdata()
        Dim formatter As IFormatter = New BinaryFormatter()
        Dim stream As Stream = New FileStream("lingosave.bin", FileMode.Create, FileAccess.Write, FileShare.None)
        formatter.Serialize(stream, players)
        stream.Close()
    End Sub

    Private Sub OnJoinedChannel(ByVal sender As Object, ByVal e As OnJoinedChannelArgs)
        client.SendMessage(e.Channel, LiveSignupChatMessage())
        If gamemode = Nothing Then gamemode = GameModes.registration
    End Sub
    Private Sub OnMessageReceived(ByVal sender As Object, ByVal e As OnMessageReceivedArgs)
        Select Case True
            Case e.ChatMessage.Message.ToLower = "!in"
                Me.Invoke(Sub() registerplayer(e.ChatMessage.Username))
            Case e.ChatMessage.Message.ToLower = "!out"
                Me.Invoke(Sub() unregisterplayer(e.ChatMessage.Username))
            Case e.ChatMessage.Message.ToLower = "!feedback"
                Me.Invoke(Sub() sendfeedback(e.ChatMessage.Username, client, "chat"))
                'Case gamemode = GameModes.guessing
                '    If System.Text.RegularExpressions.Regex.IsMatch(e.ChatMessage.Message, "^[A-Za-z]{5}$") Then
                '        client.SendMessage(e.ChatMessage.Channel, "/delete " + e.ChatMessage.Id)
                '        Me.Invoke(Sub() updateplayerguess(e.ChatMessage.Username, e.ChatMessage.Message))
                '        Me.Invoke(Sub() lockinplayerguess(e.ChatMessage.Username))
                '    End If
        End Select
    End Sub

    Private Sub registerplayer(username As String)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If players.Exists(match) Then Exit Sub
        Dim p As New Player(username)
        players.Add(p)
        players.Sort(Function(x, y) x.Name.CompareTo(y.Name))
        drawalluserresults()
        ListBox2.Items.Add(username + " - ")
        ListBox3.Items.Add(username + " - ")
    End Sub
    Private Sub unregisterplayer(username As String)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If players.Exists(match) Then
            Dim p As Player = players.Find(match)
            players.Remove(p)
        End If
        drawalluserresults()
        ListBox2.Items.Remove(username + " - ")
        ListBox3.Items.Remove(username + " - ")
    End Sub
    Private Sub updatescore(username As String, score As Integer)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If players.Exists(match) Then
            Dim p As Player = players.Find(match)
            p.Balls = score
            p.updategraphic()
            drawuserresult(p)
        End If
    End Sub

    Private Sub OnWhisperReceived(ByVal sender As Object, ByVal e As OnWhisperReceivedArgs)
        If UseWebFormOnly Then Return
        Select Case True
            Case e.WhisperMessage.Message.ToLower = "!in"
                'client.SendWhisper(e.WhisperMessage.Username, "Your entry is confirmed.")
                Me.Invoke(Sub() registerplayer(e.WhisperMessage.Username))
            Case e.WhisperMessage.Message.ToLower = "!out"
                Me.Invoke(Sub() unregisterplayer(e.WhisperMessage.Username))
            Case e.WhisperMessage.Message.ToLower = "!feedback"
                Me.Invoke(Sub() sendfeedback(e.WhisperMessage.Username, client, "whisper"))
            Case gamemode = GameModes.guessing
                If System.Text.RegularExpressions.Regex.IsMatch(e.WhisperMessage.Message, "^[A-Za-z]{5}$") Then
                    Me.Invoke(Sub() updateplayerguess(e.WhisperMessage.Username, e.WhisperMessage.Message))
                    Me.Invoke(Sub() lockinplayerguess(e.WhisperMessage.Username))
                    Dim stillwaiting As Boolean = False
                    For Each p As Player In players
                        If (p.guess = "" AndAlso p.roundresult(roundnum - 1) < 1) OrElse p.guess = "@@@@@" Then stillwaiting = True
                    Next
                    If Not stillwaiting Then Me.Invoke(Sub() Button1.PerformClick())
                Else
                    Me.Invoke(Sub() updateplayernotes(e.WhisperMessage.Username, e.WhisperMessage.Message))
                End If
                'Case gamemode = GameModes.results
                '    Dim match As Predicate(Of Player) = Function(pl) pl.Name = e.WhisperMessage.Username
                '    If players.Exists(match) Then
                '        Dim p As Player = players.Find(match)
                '        If p.guess = "" Then
                '            If System.Text.RegularExpressions.Regex.IsMatch(e.WhisperMessage.Message, "^[A-Za-z]{5}$") Then
                '                Me.Invoke(Sub() updateplayerguess(e.WhisperMessage.Username, e.WhisperMessage.Message))
                '                Me.Invoke(Sub() lockinplayerguess(e.WhisperMessage.Username))

                '                Dim beenguessed As Boolean = False
                '                If wordlist.Contains(p.guess.ToUpper) AndAlso p.roundresult(roundnum - 1) = 0 Then
                '                        p.updategraphic(getLingoResult(Label4.Text, p.guess))
                '                    ElseIf p.guess <> "@@@@@" AndAlso p.roundresult(roundnum - 1) = 0 Then
                '                        If p.guess = "" Then p.updategraphic("     ") Else p.updategraphic("\\\\\")
                '                    End If
                '                    If beenguessed = False AndAlso p.roundresult(roundnum - 1) >= 1 Then beenguessed = True
                '                p.allguesses.Add(p.guess)
                '                drawalluserresults()

                '            Else
                '                Me.Invoke(Sub() updateplayernotes(e.WhisperMessage.Username, e.WhisperMessage.Message))
                '            End If
                '        End If
                '    End If
            Case Else
                Me.Invoke(Sub() updateplayernotes(e.WhisperMessage.Username, e.WhisperMessage.Message))
        End Select
    End Sub

    Private Sub sendfeedback(username As String, client As TwitchClient, mode As String)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If Not players.Exists(match) Then Return
        Dim p As Player = players.Find(match)
        Dim deliveryMode As String = mode
        If UseWebFormOnly AndAlso deliveryMode = "whisper" Then deliveryMode = "chat"
        p.setfeedback(deliveryMode)
        If deliveryMode = "whisper" Then
            client.SendWhisper(username, p.feedback)
        ElseIf deliveryMode = "chat" Then
            client.SendMessage(channel, p.feedback)
        End If
    End Sub

    Private Sub lockinplayerguess(username As String)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If players.Exists(match) Then
            Dim p As Player = players.Find(match)
            p.updategraphic("     ", True)
            drawuserresult(p)
        End If
    End Sub

    Private Sub updateplayerguess(username As String, message As String)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If players.Exists(match) Then
            Dim p As Player = players.Find(match)
            p.guess = message
            For i As Integer = 0 To ListBox2.Items.Count - 1
                If ListBox2.Items(i).StartsWith(username + " - ") Then
                    ListBox2.Items(i) = username + " - " + message.ToUpper
                    Exit For
                End If
            Next
        End If
    End Sub
    Private Sub updateplayernotes(username As String, message As String)
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
        If players.Exists(match) Then
            Dim p As Player = players.Find(match)
            p.notes.Add(message)
            For i As Integer = 0 To ListBox3.Items.Count - 1
                If ListBox3.Items(i).StartsWith(username + " - ") Then
                    ListBox3.Items(i) = username + " - " + message
                    Exit For
                End If
            Next
            p.hasnotes = True
        End If
    End Sub

    Private Sub Button1_Click(sender As Object, e As EventArgs) Handles Button1.Click
        gamemode = GameModes.results
        Dim beenguessed As Boolean = False
        For Each p As Player In players
            If wordlist.Contains(p.guess.ToUpper) AndAlso p.roundresult(roundnum - 1) = 0 Then
                p.updategraphic(getLingoResult(Label4.Text, p.guess))
            ElseIf p.guess <> "@@@@@" AndAlso p.roundresult(roundnum - 1) = 0 Then
                If p.guess = "" Then p.updategraphic("     ") Else p.updategraphic("\\\\\")
            End If
            If beenguessed = False AndAlso p.roundresult(roundnum - 1) >= 1 Then beenguessed = True
            p.allguesses.Add(p.guess)
        Next

        Dim lastGuessWasTwoBall As Boolean = (numballs = 2 * ballmultiplier)
        If numballs = 6 * ballmultiplier Then numballs = 5 * ballmultiplier
        If beenguessed Then numballs -= 1 * ballmultiplier
        If lastGuessWasTwoBall Then answerRevealed = True
        drawalluserresults()
        If lastGuessWasTwoBall Then
            AnnounceWordAnswer()
            gametimer.Stop()
        ElseIf numballs >= 2 * ballmultiplier Then
            While client.JoinedChannels.Count = 0
                client.Connect()
                Threading.Thread.Sleep(5000)
            End While
            Me.Invoke(Sub() client.SendMessage(client.JoinedChannels(0), "Time's up!  You now have 45 seconds to look at your feedback.  To see this at any time, type !feedback in chat."))
            gametime = 45
            gametimer.Start()
        Else
            gametimer.Stop()
        End If
    End Sub

    Private Sub AnnounceWordAnswer()
        While client.JoinedChannels.Count = 0
            client.Connect()
            Threading.Thread.Sleep(5000)
        End While
        If client.JoinedChannels.Count > 0 Then
            client.SendMessage(client.JoinedChannels(0), "The word was: " + Label4.Text.ToUpper() + "!")
        End If
    End Sub

    Private Sub drawalluserresults()
        If bingoOverlayActive Then
            DrawBingoOverlay()
            Return
        End If
        Using g As Graphics = PublicDisplay.PictureBox1.CreateGraphics
            g.DrawImage(My.Resources.lingobg11, 0, 0, 1920, 1080)
            Using sf As New StringFormat
                sf.Alignment = StringAlignment.Center
                Dim r2 As New Rectangle(0, 0, 1920, 60)
                Dim r3 As New Rectangle(0, 1020, 1920, 60)
                Dim gp As New GraphicsPath()
                Using f As FontFamily = New FontFamily("Boomer Tantrum")
                    If answerRevealed Then
                        gp.AddString("THE WORD WAS: " + Label4.Text.ToUpper(), f, FontStyle.Regular, g.DpiY * 72 / 72, r2, sf)
                        gp.AddString("Here are the results.  DO NOT GUESS NOW!", f, FontStyle.Regular, g.DpiY * 48 / 72, r3, sf)
                        sf.LineAlignment = StringAlignment.Center
                        Dim rCenter As New Rectangle(0, 380, 1920, 220)
                        gp.AddString(Label4.Text.ToUpper(), f, FontStyle.Regular, g.DpiY * 120 / 72, rCenter, sf)
                        sf.LineAlignment = StringAlignment.Near
                    ElseIf roundnum > 0 Then
                        gp.AddString("This guess worth " + numballs.ToString + " balls", f, FontStyle.Regular, g.DpiY * 48 / 72, r2, sf)
                    End If
                    If Not answerRevealed Then
                        If gamemode = GameModes.results Then
                            gp.AddString("Here are the results.  DO NOT GUESS NOW!", f, FontStyle.Regular, g.DpiY * 48 / 72, r3, sf)
                        Else
                            If roundnum > 0 Then gp.AddString("Word #" + roundnum.ToString + ", first letter is " + Label4.Text(0).ToString.ToUpper, f, FontStyle.Regular, g.DpiY * 48 / 72, r3, sf)
                        End If
                    End If
                    sf.LineAlignment = StringAlignment.Far
                    g.DrawPath(Pens.Black, gp)
                    g.FillPath(Brushes.White, gp)
                End Using
            End Using
            Dim num As Integer = players.Count
            If num > 0 Then
                Dim numcolumns As Integer = Math.Ceiling((num * 0.8) ^ 0.5)
                Dim numrows As Integer = Math.Ceiling(num / numcolumns)
                Dim unitwidth As Integer = Math.Floor(1900 / (numcolumns + 1))
                Dim gapwidth As Integer = 0
                If numcolumns > 1 Then gapwidth = Math.Floor(unitwidth / (2 * (numcolumns - 1)))
                Dim temp As Integer = unitwidth
                unitwidth += gapwidth * (numcolumns - 1) / numcolumns
                Dim unitheight As Integer = Math.Floor(unitwidth * 3 / 8)
                Dim gapheight As Integer = 0
                If numrows > 1 Then gapheight = Math.Floor(unitheight / (8 * (numrows - 1)))
                Dim extra As Integer = Math.Max(0, Math.Floor((1900 - (unitwidth * numcolumns) - (gapwidth * (numcolumns - 1))) / 2))
                Dim eytra As Integer = Math.Max(0, Math.Floor((880 - (unitheight * numrows) - (gapheight * (numrows - 1))) / 2))
                For x As Integer = 0 To numcolumns - 1
                    For y As Integer = 0 To numrows - 1
                        Try
                            players.Item(numcolumns * y + x).position = New Point((x * (unitwidth + gapwidth)) + 10 + extra, (y * (unitheight + gapheight)) + 100 + eytra)
                            players.Item(numcolumns * y + x).size = New Size(unitwidth, unitheight)
                            g.DrawImage(players.Item(numcolumns * y + x).graphic, (x * (unitwidth + gapwidth)) + 10 + extra, (y * (unitheight + gapheight)) + 100 + eytra, unitwidth, unitheight)
                        Catch
                        End Try
                    Next
                Next
            End If
        End Using
        Using g As Graphics = PublicDisplay.PictureBox2.CreateGraphics
            g.DrawImage(My.Resources.hack2, 0, 0)
        End Using
    End Sub
    Private Sub drawuserresult(p As Player)
        Using g As Graphics = PublicDisplay.PictureBox1.CreateGraphics
            g.DrawImage(p.graphic, p.position.X, p.position.Y, p.size.Width, p.size.Height)
            'PublicDisplay.PictureBox1.Invalidate(New Rectangle(p.position.X, p.position.Y, p.size.Width, p.size.Height))
        End Using
    End Sub
    Private Sub ListBox1_MouseDoubleClick(sender As Object, e As MouseEventArgs) Handles ListBox1.MouseDoubleClick
        Label4.Text = ListBox1.SelectedItem
    End Sub

    Private Sub ListBox1_MouseDown(sender As Object, e As MouseEventArgs) Handles ListBox1.MouseDown
        If e.Button = MouseButtons.Right Then
            wordlist.Remove(ListBox1.SelectedItem)
            ListBox1.Items.Remove(ListBox1.SelectedItem)

        End If
    End Sub
    Private Sub Button2_Click(sender As Object, e As EventArgs) Handles Button2.Click
        roundnum += 1
        gamemode = GameModes.guessing
        answerRevealed = False
        processedWebGuesses.Clear()
        numballs = 6 * ballmultiplier
        For Each p As Player In players
            p.updategraphic("     ", False)
            p.guess = ""
            p.allguesses.Clear()
        Next
        drawalluserresults()
        For i As Integer = 0 To ListBox2.Items.Count - 1
            ListBox2.Items(i) = ListBox2.Items(i).ToString.Split(" - ")(0) + " - "
        Next
        While client.JoinedChannels.Count = 0
            client.Connect()
            Threading.Thread.Sleep(5000)
        End While
        Me.Invoke(Sub() client.SendMessage(client.JoinedChannels(0), "Round " + roundnum.ToString + " has started!  The first letter is " + Label4.Text.Chars(0) + ".  You have 90 seconds. " + WebGuessInstructions()))
        gametime = 90
        gametimer.Start()
    End Sub

    Private Sub Button3_Click(sender As Object, e As EventArgs) Handles Button3.Click
        gamemode = GameModes.guessing
        processedWebGuesses.Clear()
        For Each p As Player In players
            p.guess = ""
            p.updategraphic("     ", False)
        Next
        drawalluserresults()
        For i As Integer = 0 To ListBox2.Items.Count - 1
            ListBox2.Items(i) = ListBox2.Items(i).ToString.Split(" - ")(0) + " - "
        Next
        While client.JoinedChannels.Count = 0
            client.Connect()
            Threading.Thread.Sleep(5000)
        End While
        Me.Invoke(Sub() client.SendMessage(client.JoinedChannels(0), "Round " + roundnum.ToString + " continues for " + numballs.ToString + " balls!  The first letter is " + Label4.Text.Chars(0) + ".  You have 90 seconds. " + WebGuessInstructions()))
        gametime = 90
        gametimer.Start()
    End Sub

    Private Sub GameTimer_Tick(sender As Object, e As ElapsedEventArgs)
        gametime -= 1
        Select Case True
            Case gametime = 30 AndAlso gamemode = GameModes.guessing
                If Not (client.JoinedChannels.Count = 0) Then client.SendMessage(client.JoinedChannels(0), "30 seconds to go...")
            Case gametime = 10 AndAlso gamemode = GameModes.guessing
                If Not (client.JoinedChannels.Count = 0) Then client.SendMessage(client.JoinedChannels(0), "LAST CHANCE, 10 seconds...")
                'Case gametime = 100
                'client.SendMessage(client.JoinedChannels(0), "10 seconds left...")
                'Case gametime = 50
                'client.SendMessage(client.JoinedChannels(0), "5 seconds...")
        End Select
        If gametime <= 0 Then
            sender.Stop()
            If gamemode = GameModes.guessing Then
                Me.Invoke(Sub() Button1.PerformClick())
            ElseIf gamemode = GameModes.results Then
                Me.Invoke(Sub() Button3.PerformClick())
            End If
        End If
        Me.Invoke(Sub() updatetimer())

    End Sub

    Private Sub updatetimer()
        Dim bmp As New Bitmap(200, 100)
        Using g As Graphics = PublicDisplay.PictureBox2.CreateGraphics
            g.DrawImage(My.Resources.hack2, 0, 0)
            Using sf As New StringFormat
                sf.LineAlignment = StringAlignment.Center
                Dim r2 As New Rectangle(50, 0, 100, 100)
                Dim gp As New GraphicsPath()
                Using f As FontFamily = New FontFamily("Boomer Tantrum")
                    gp.AddString(gametime.ToString, f, FontStyle.Regular, g.DpiY * 40 / 72, r2, sf)
                    g.FillPath(Brushes.Yellow, gp)
                End Using
            End Using
            g.DrawImage(bmp, 0, 0)
            g.DrawRectangle(Pens.Yellow, New Rectangle(0, 0, bmp.Width, bmp.Height))
        End Using
    End Sub

    Private Sub Button4_Click(sender As Object, e As EventArgs) Handles Button4.Click
        For Each p As Player In players
            p.Balls += 1
            p.updategraphic()
            'drawuserresult(p)
        Next
        drawalluserresults()
    End Sub

    Friend Function getLingoResult(target As String, guess As String) As String
        If target.ToUpper = guess.ToUpper Then Return "!!!!!"
        Dim temptarget As New StringBuilder(target.ToUpper, 5)
        Dim tempguess As New StringBuilder(guess.ToUpper, 5)
        For i As Integer = 0 To 4
            If target.ToUpper()(i) = guess.ToUpper()(i) Then
                temptarget(i) = "."
                tempguess(i) = "!"
            End If
        Next
        For i As Integer = 0 To 4
            If temptarget.ToString.Contains(tempguess(i)) Then
                For j As Integer = 0 To 4
                    If temptarget(j) = tempguess(i) Then
                        temptarget(j) = "."
                        Exit For
                    End If
                Next
                tempguess(i) = "?"
            ElseIf tempguess(i) <> "!" Then
                tempguess(i) = "/"
            End If
        Next
        Return tempguess.ToString
    End Function

    Private Sub ListBox2_MouseDown(sender As Object, e As MouseEventArgs) Handles ListBox2.MouseDown
        ListBox2.SelectedIndex = ListBox2.IndexFromPoint(e.X, e.Y)
        If ListBox2.SelectedIndex = -1 Then Exit Sub
        Dim username As String = ListBox2.SelectedItem.ToString.Substring(0, ListBox2.SelectedItem.ToString.IndexOf(" - "))
        If e.Button = MouseButtons.Right Then
            Select Case MessageBox.Show("Are you sure you want to remove this player?  This cannot be undone.", "Remove player?", MessageBoxButtons.YesNo) = DialogResult.Yes
                Case True
                    unregisterplayer(username)
                    drawalluserresults()
                Case False
            End Select
        ElseIf e.Button = MouseButtons.Left Then
            Dim newscore As Integer = CInt(InputBox("Update score"))
            updatescore(username, newscore)
        End If
    End Sub

    Private Sub Button5_Click(sender As Object, e As EventArgs) Handles Button5.Click
        Dim formatter As IFormatter = New BinaryFormatter()
        Dim stream As Stream = New FileStream("lingosave.bin", FileMode.Open, FileAccess.Read, FileShare.Read)
        players = formatter.Deserialize(stream)
        stream.Close()
        drawalluserresults()
    End Sub

    Private Sub Button6_Click(sender As Object, e As EventArgs) Handles Button6.Click
        dumpdata()
    End Sub

    Private Sub ListBox3_MouseDown(sender As Object, e As MouseEventArgs) Handles ListBox3.MouseDown
        If e.Button = MouseButtons.Left Then
            ListBox3.SelectedIndex = ListBox3.IndexFromPoint(e.X, e.Y)
            If ListBox3.SelectedIndex = -1 Then Exit Sub
            Dim username As String = ListBox3.SelectedItem.ToString.Substring(0, ListBox3.SelectedItem.ToString.IndexOf(" - "))
            Dim match As Predicate(Of Player) = Function(pl) pl.Name = username
            If players.Exists(match) Then
                Dim p As Player = players.Find(match)
                Dim notes As String = ""
                For Each n As String In p.notes
                    notes = notes & n & vbCrLf
                Next
                MessageBox.Show(notes)
            End If
        End If
    End Sub

    Private Sub Button7_Click(sender As Object, e As EventArgs) Handles Button7.Click
        gametimer.Enabled = Not gametimer.Enabled
        Select Case sender.Text
            Case "Pause"
                sender.Text = "Resume"
            Case "Resume"
                sender.Text = "Pause"
        End Select
    End Sub

    Private Sub Button8_Click(sender As Object, e As EventArgs) Handles Button8.Click
        Dim newchamp As Boolean = False
        Dim champ As String = InputBox("Crown A New Champion", "", My.Settings.champion).ToLower()
        Dim match As Predicate(Of Player) = Function(pl) pl.Name = champ
        If players.Exists(match) Then
            Dim p As Player = players.Find(match)
            p.ischamp = True
            p.updategraphic()
            newchamp = True
        End If
        Dim match2 As Predicate(Of Player) = Function(pl) pl.Name = My.Settings.champion
        If newchamp AndAlso players.Exists(match2) Then
            Dim p As Player = players.Find(match2)
            p.ischamp = False
            p.updategraphic()
        End If
        If newchamp Then
            drawalluserresults()
            My.Settings.champion = champ
            My.Settings.Save()
        End If
    End Sub

    Private Sub Button10_Click(sender As Object, e As EventArgs) Handles Button10.Click
        If bingoHostForm Is Nothing OrElse bingoHostForm.IsDisposed Then
            bingoHostForm = New BingoHostForm(Me)
        End If
        bingoHostForm.Show()
        bingoHostForm.BringToFront()
    End Sub

    Private Sub Button9_Click(sender As Object, e As EventArgs) Handles Button9.Click
        If MsgBox("This mode cannot be disabled.  Are you sure?", MsgBoxStyle.YesNo, "Enable 2x Ball Mode") <> MsgBoxResult.No Then
            ballmultiplier = 2
            Button9.Enabled = False
            If client.JoinedChannels.Count > 0 Then
                client.SendMessage(client.JoinedChannels(0), "Hold your hats everyone, now we're playing for DOUBLE BALLS!")
            End If
        End If
    End Sub

    Private Sub TextBox1_TextChanged(sender As Object, e As EventArgs) Handles TextBox1.TextChanged
    End Sub

    Private Sub TextBox1_KeyDown(sender As Object, e As KeyEventArgs) Handles TextBox1.KeyDown
        If e.KeyCode = Keys.Enter Then
            Label4.Text = TextBox1.Text.ToUpper()
        End If
    End Sub

    Private Sub Form1_Closing(sender As Object, e As CancelEventArgs) Handles Me.Closing
        If firestoreListener IsNot Nothing Then firestoreListener.StopListening()
        dumpdata()
    End Sub
End Class
